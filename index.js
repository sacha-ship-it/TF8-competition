require('dotenv').config();

const {
  Client, GatewayIntentBits, Partials,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle,
  EmbedBuilder, Events, SlashCommandBuilder,
  REST, Routes, PermissionFlagsBits
} = require('discord.js');

const axios = require('axios');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const RANK_CHANNEL_ID = process.env.RANK_CHANNEL_ID;

for (const key of [
  'TOKEN', 'CLIENT_ID', 'GUILD_ID',
  'LOG_CHANNEL_ID', 'RANK_CHANNEL_ID'
]) {
  if (!process.env[key]) {
    throw new Error(`Missing environment variable: ${key}`);
  }
}

const STARTING_CAPITAL = 50000;

const ASSETS = {
  BTC:    { name: 'Bitcoin',         source: 'crypto', id: 'bitcoin' },
  ETH:    { name: 'Ethereum',        source: 'crypto', id: 'ethereum' },
  SOL:    { name: 'Solana',          source: 'crypto', id: 'solana' },
  BNB:    { name: 'BNB',             source: 'crypto', id: 'binancecoin' },
  XRP:    { name: 'XRP',             source: 'crypto', id: 'ripple' },
  NVDA:   { name: 'Nvidia',          source: 'yahoo',  id: 'NVDA' },
  TSLA:   { name: 'Tesla',           source: 'yahoo',  id: 'TSLA' },
  AAPL:   { name: 'Apple',           source: 'yahoo',  id: 'AAPL' },
  MSFT:   { name: 'Microsoft',       source: 'yahoo',  id: 'MSFT' },
  AMZN:   { name: 'Amazon',          source: 'yahoo',  id: 'AMZN' },
  META:   { name: 'Meta',            source: 'yahoo',  id: 'META' },
  SPY:    { name: 'S&P 500 ETF',     source: 'yahoo',  id: 'SPY' },
  QQQ:    { name: 'Nasdaq ETF',      source: 'yahoo',  id: 'QQQ' },
  GLD:    { name: 'Gold ETF',        source: 'yahoo',  id: 'GLD' },
  SLV:    { name: 'Silver ETF',      source: 'yahoo',  id: 'SLV' },
  USO:    { name: 'Oil (WTI) ETF',   source: 'yahoo',  id: 'USO' },
  UNG:    { name: 'Natural Gas ETF', source: 'yahoo',  id: 'UNG' },
  EURUSD: { name: 'EUR/USD',         source: 'yahoo',  id: 'EURUSD=X' },
  GBPUSD: { name: 'GBP/USD',         source: 'yahoo',  id: 'GBPUSD=X' },
  CADUSD: { name: 'CAD/USD',         source: 'yahoo',  id: 'CAD=X' },
};

let priceCache = {};
let lastFetch = 0;
let fetchInFlight;

async function fetchPrices() {
  if (Date.now() - lastFetch < 60_000) return priceCache;
  if (fetchInFlight) return fetchInFlight;

  fetchInFlight = (async () => {
    const prices = {};
    const crypto = Object.entries(ASSETS)
      .filter(([, asset]) => asset.source === 'crypto');
    const yahoo = Object.entries(ASSETS)
      .filter(([, asset]) => asset.source === 'yahoo');

    await Promise.all([
      (async () => {
        try {
          const response = await axios.get(
            'https://api.coingecko.com/api/v3/simple/price',
            {
              params: {
                ids: crypto.map(([, asset]) => asset.id).join(','),
                vs_currencies: 'usd'
              },
              timeout: 8000
            }
          );

          for (const [ticker, asset] of crypto) {
            const value = response.data?.[asset.id]?.usd;
            if (Number.isFinite(value) && value > 0) {
              prices[ticker] = value;
            }
          }
        } catch (_) {
          console.error('CoinGecko prices unavailable.');
        }
      })(),

      ...yahoo.map(async ([ticker, asset]) => {
        try {
          const response = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(asset.id)}`,
            {
              params: { interval: '1d', range: '1d' },
              timeout: 8000,
              headers: { 'User-Agent': 'Mozilla/5.0' }
            }
          );

          const meta = response.data?.chart?.result?.[0]?.meta;
          const value = meta?.regularMarketPrice || meta?.previousClose;

          if (Number.isFinite(value) && value > 0) {
            prices[ticker] = value;
          }
        } catch (_) {
          console.error(`Yahoo price unavailable for ${ticker}.`);
        }
      })
    ]);

    priceCache = prices;
    lastFetch = Date.now();
    return priceCache;
  })();

  try {
    return await fetchInFlight;
  } finally {
    fetchInFlight = null;
  }
}

let logMessage = null;
let dbRows = [];
let ready = false;
let mutationQueue = Promise.resolve();

const STORAGE_MARKER = 'TF8_TRADING_CSV_V2';

async function loadData(client) {
  const channel = await client.channels.fetch(LOG_CHANNEL_ID);

  if (!channel?.isTextBased() || !channel.messages) {
    throw new Error('Invalid storage channel.');
  }

  let before;

  while (!logMessage) {
    const messages = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {})
    });

    logMessage = messages.find(message =>
      message.author.id === client.user.id &&
      (
        message.content === STORAGE_MARKER ||
        message.content.startsWith('```csv')
      )
    );

    if (logMessage || messages.size < 100) break;
    before = messages.last().id;
  }

  if (logMessage) {
    let raw = logMessage.content;

    if (raw === STORAGE_MARKER) {
      const attachment = logMessage.attachments.find(
        item => item.name === 'participants.csv'
      );

      if (!attachment) {
        throw new Error('Storage attachment missing.');
      }

      raw = (await axios.get(attachment.url, {
        responseType: 'text',
        timeout: 15000
      })).data;
    }

    dbRows = parseCSV(raw);
  } else {
    logMessage = await channel.send(
      '```csv\ndiscord_id,capital,positions,joined_at,starting_capital\n```'
    );
  }

  await saveData();
}

function parseCSV(raw) {
  const lines = String(raw)
    .replace(/^```csv\r?\n/, '')
    .replace(/\r?\n```\s*$/, '')
    .trim()
    .split(/\r?\n/);

  const header = lines.shift().replace(/^\uFEFF/, '').split(',');

  for (const key of ['discord_id', 'capital', 'positions', 'joined_at']) {
    if (!header.includes(key)) {
      throw new Error('Invalid CSV header.');
    }
  }

  return lines.filter(line => line.trim()).map(line => {
    const cells = line.split(',');
    const read = key => cells[header.indexOf(key)];
    const capital = Number(read('capital'));
    const discord_id = read('discord_id');

    if (
      !/^\d{17,20}$/.test(discord_id) ||
      !Number.isFinite(capital) ||
      capital < 0
    ) {
      throw new Error(
        'Invalid participant record; storage was not overwritten.'
      );
    }

    const positions = read('positions')
      ? JSON.parse(
          Buffer.from(read('positions'), 'base64').toString('utf8')
        )
      : {};

    if (
      !positions ||
      typeof positions !== 'object' ||
      Array.isArray(positions)
    ) {
      throw new Error('Invalid positions.');
    }

    for (const [ticker, position] of Object.entries(positions)) {
      if (
        !ASSETS[ticker] ||
        !Number.isFinite(position.qty) ||
        position.qty < 0 ||
        !Number.isFinite(position.avg_price) ||
        position.avg_price <= 0
      ) {
        throw new Error(
          'Invalid stored position; storage was not overwritten.'
        );
      }
    }

    // Preserve the original performance baseline for legacy accounts.
    const baseline = header.includes('starting_capital')
      ? Number(read('starting_capital'))
      : 10000;

    if (!Number.isFinite(baseline) || baseline <= 0) {
      throw new Error('Invalid starting capital.');
    }

    return {
      discord_id,
      capital,
      positions,
      joined_at: read('joined_at') || '',
      starting_capital: baseline
    };
  });
}

async function saveData() {
  const lines = [
    'discord_id,capital,positions,joined_at,starting_capital'
  ];

  for (const row of dbRows) {
    const positions = Buffer.from(
      JSON.stringify(row.positions || {})
    ).toString('base64');

    lines.push(
      `${row.discord_id},${row.capital},${positions},${row.joined_at},${row.starting_capital}`
    );
  }

  const csv = lines.join('\n');
  const content = '```csv\n' + csv + '\n```';

  logMessage = await logMessage.edit(
    content.length <= 2000
      ? { content, attachments: [] }
      : {
          content: STORAGE_MARKER,
          attachments: [],
          files: [{
            attachment: Buffer.from(csv),
            name: 'participants.csv'
          }]
        }
  );
}

function getUser(id) {
  return dbRows.find(row => row.discord_id === id);
}

async function ensureUser(id) {
  let user = getUser(id);

  if (!user) {
    user = {
      discord_id: id,
      capital: STARTING_CAPITAL,
      positions: {},
      joined_at: new Date().toISOString().split('T')[0],
      starting_capital: STARTING_CAPITAL
    };

    dbRows.push(user);
    await saveData();
  }

  return user;
}

async function getRanked(prices) {
  if (!prices) prices = await fetchPrices();

  return dbRows.map(user => {
    let invested = 0;

    for (const [ticker, position] of Object.entries(user.positions || {})) {
      if (!prices[ticker]) {
        throw new Error(
          'A position price is unavailable. Please try again later.'
        );
      }

      invested += position.qty * prices[ticker];
    }

    return {
      discord_id: user.discord_id,
      total: user.capital + invested,
      starting_capital: user.starting_capital
    };
  }).sort((a, b) => b.total - a.total);
}

async function rankingEmbed() {
  const prices = await fetchPrices();
  const ranked = await getRanked(prices);
  const medals = ['🥇', '🥈', '🥉'];

  const lines = ranked.slice(0, 15).map((row, index) => {
    const pnl = row.total - row.starting_capital;
    const percentage = ((pnl / row.starting_capital) * 100).toFixed(2);
    const sign = pnl >= 0 ? '+' : '';

    return `${medals[index] || `\`${index + 1}.\``} <@${row.discord_id}> - **$${row.total.toFixed(0)}** (${sign}${percentage}%)`;
  });

  return new EmbedBuilder()
    .setColor(0xf9a825)
    .setTitle('🏆 TF8 Trading Competition Rankings')
    .setDescription(
      lines.length ? lines.join('\n') : 'No participants yet.'
    )
    .setFooter({
      text: `${ranked.length} participants · Starting cash $${STARTING_CAPITAL.toLocaleString('en-US')}`
    })
    .setTimestamp();
}

async function portfolioEmbed(user, member) {
  const prices = await fetchPrices();
  let invested = 0;
  const positionLines = [];

  for (const [ticker, position] of Object.entries(user.positions || {})) {
    if (position.qty <= 0) continue;

    const price = prices[ticker];

    if (!price) {
      throw new Error(
        'A position price is unavailable. Please try again later.'
      );
    }

    const value = position.qty * price;
    const cost = position.qty * position.avg_price;
    const pnl = value - cost;
    const percentage = ((pnl / cost) * 100).toFixed(2);

    invested += value;

    positionLines.push(
      `${pnl >= 0 ? '🟢' : '🔴'} **${ticker}** · $${value.toFixed(2)} (${pnl >= 0 ? '+' : ''}${percentage}%)`
    );
  }

  const total = user.capital + invested;
  const globalPnl = total - user.starting_capital;
  const globalPercentage = (
    (globalPnl / user.starting_capital) * 100
  ).toFixed(2);

  const ranked = await getRanked(prices);
  const rank = ranked.findIndex(
    row => row.discord_id === user.discord_id
  ) + 1;

  return new EmbedBuilder()
    .setColor(globalPnl >= 0 ? 0x00c853 : 0xff1744)
    .setTitle(`📊 Portfolio | ${member.displayName}`)
    .addFields(
      {
        name: '💰 Total balance',
        value: `**$${total.toFixed(2)}**`,
        inline: true
      },
      {
        name: '📈 Performance',
        value: `**${globalPnl >= 0 ? '+' : ''}${globalPercentage}%**`,
        inline: true
      },
      {
        name: '🏆 Rank',
        value: `**#${rank}** / ${ranked.length}`,
        inline: true
      },
      {
        name: '💵 Available cash',
        value: `$${user.capital.toFixed(2)}`,
        inline: true
      },
      {
        name: '📦 Invested',
        value: `$${invested.toFixed(2)}`,
        inline: true
      },
      { name: '\u200b', value: '\u200b', inline: true },
      {
        name: `Positions (${positionLines.length})`,
        value: positionLines.length
          ? positionLines.join('\n')
          : '_No positions - click **Buy** to get started._'
      }
    )
    .setFooter({
      text: 'TF8 Trading Competition · Market prices'
    })
    .setTimestamp();
}

function tradingPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0x1565c0)
    .setTitle('📈 TF8 Trading Competition')
    .setDescription(
      '**Virtual trading. Real prices. Live rankings.**\n\n' +
      'Start with **$50,000 virtual cash** to invest across 20 real assets.\n' +
      'BTC, ETH, Tesla, NVIDIA, S&P 500, Gold, Forex and more.\n' +
      'Prices come from CoinGecko and Yahoo Finance. The best trader of the month wins a TF8 reward.\n\n' +
      'Click **Portfolio**, **Buy**, or **Sell** to join automatically and start trading.'
    )
    .setFooter({
      text: 'TF8 Trading Competition · Rankings posted every morning at 9 AM (Europe/Paris)'
    });
}

async function refreshTradingPanels() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const channels = await guild.channels.fetch();

  for (const channel of channels.values()) {
    if (
      !channel?.isTextBased() ||
      !channel.messages ||
      channel.id === LOG_CHANNEL_ID
    ) continue;

    let before;

    try {
      while (true) {
        const messages = await channel.messages.fetch({
          limit: 100,
          ...(before ? { before } : {})
        });

        for (const message of messages.values()) {
          if (message.author.id !== client.user.id) continue;

          const ids = message.components.flatMap(
            row => row.components.map(component => component.customId)
          );

          const panelIds = [
            'btn_portfolio',
            'btn_buy_menu',
            'btn_sell_menu',
            'btn_prices',
            'btn_ranking'
          ];

          if (!panelIds.every(id => ids.includes(id))) continue;

          await message.edit({
            content: '',
            embeds: [tradingPanelEmbed()],
            components: [mainMenuRow()],
            allowedMentions: { parse: [] }
          });
        }

        if (messages.size < 100) break;
        before = messages.last().id;
      }
    } catch (_) {
      console.error(
        `Unable to refresh trading panels in channel ${channel.id}. Check View Channel, Read Message History, and Send Messages permissions.`
      );
    }
  }
}

function mainMenuRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_portfolio')
      .setLabel('📊 Portfolio')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('btn_buy_menu')
      .setLabel('💸 Buy')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('btn_sell_menu')
      .setLabel('📤 Sell')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('btn_prices')
      .setLabel('📈 Prices')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_ranking')
      .setLabel('🏆 Rankings')
      .setStyle(ButtonStyle.Secondary)
  );
}

function assetSelectMenu(customId, placeholder) {
  const options = Object.entries(ASSETS).map(([ticker, asset]) => ({
    label: `${ticker} - ${asset.name}`,
    value: ticker
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .addOptions(options)
  );
}

const commands = [
  new SlashCommandBuilder()
    .setName('setup-trading')
    .setDescription('[Admin] Post the Trading Competition panel in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('ranking')
    .setDescription('[Admin] Post the rankings now')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('reset-competition')
    .setDescription('[Admin] Reset all portfolios to $50,000')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('winner')
    .setDescription('[Admin] Show the competition winner')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(command => command.toJSON());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Message, Partials.Channel]
});

client.once(Events.ClientReady, async () => {
  try {
    console.log(`✅ Connected: ${client.user.tag}`);

    const rest = new REST({ version: '10' }).setToken(TOKEN);

    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );

    console.log('✅ Admin commands registered');

    await loadData(client);

    console.log(`✅ ${dbRows.length} participants loaded`);

    ready = true;
    scheduleDaily();

    refreshTradingPanels().catch(() => {
      console.error(
        'Unable to refresh existing trading panels. Run /setup-trading to publish the updated panel.'
      );
    });
  } catch (_) {
    console.error(
      'Startup failed. Check configuration, channel permissions, and storage.'
    );
    client.destroy();
    process.exitCode = 1;
  }
});

async function handleInteraction(interaction) {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'setup-trading') {
      await interaction.channel.send({
        embeds: [tradingPanelEmbed()],
        components: [mainMenuRow()]
      });

      return interaction.reply({
        content: '✅ Trading panel posted.',
        ephemeral: true
      });
    }

    if (interaction.commandName === 'ranking') {
      await interaction.deferReply();
      return interaction.editReply({
        embeds: [await rankingEmbed()]
      });
    }

    if (interaction.commandName === 'reset-competition') {
      await interaction.deferReply({ ephemeral: true });

      for (const row of dbRows) {
        row.capital = STARTING_CAPITAL;
        row.positions = {};
        row.starting_capital = STARTING_CAPITAL;
      }

      await saveData();

      return interaction.editReply({
        content: `✅ ${dbRows.length} portfolios reset ($${STARTING_CAPITAL.toLocaleString('en-US')}).`
      });
    }

    if (interaction.commandName === 'winner') {
      await interaction.deferReply();

      const ranked = await getRanked();

      if (!ranked.length) {
        return interaction.editReply({
          content: 'No participants yet.'
        });
      }

      const winner = ranked[0];
      const pnl = winner.total - winner.starting_capital;
      const percentage = (
        (pnl / winner.starting_capital) * 100
      ).toFixed(2);

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xffd700)
            .setTitle('🏆 TF8 Trading Competition Winner!')
            .setDescription(
              `🥇 <@${winner.discord_id}>\n\n` +
              `**Final balance: $${winner.total.toFixed(2)}**\n` +
              `Performance: **${pnl >= 0 ? '+' : ''}${percentage}%**`
            )
            .setTimestamp()
        ]
      });
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId === 'btn_portfolio') {
      await interaction.deferReply({ ephemeral: true });

      const user = await ensureUser(interaction.user.id);

      return interaction.editReply({
        embeds: [await portfolioEmbed(user, interaction.member)]
      });
    }

    if (interaction.customId === 'btn_buy_menu') {
      const user = await ensureUser(interaction.user.id);

      return interaction.reply({
        content:
          '**Which asset would you like to buy?**\n' +
          `Available cash: **$${user.capital.toFixed(2)}**`,
        components: [
          assetSelectMenu('sel_buy_asset', 'Choose an asset...')
        ],
        ephemeral: true
      });
    }

    if (interaction.customId === 'btn_sell_menu') {
      const user = await ensureUser(interaction.user.id);
      const positions = Object.entries(user.positions || {})
        .filter(([, position]) => position.qty > 0);

      if (!positions.length) {
        return interaction.reply({
          content: '❌ You have no open positions.',
          ephemeral: true
        });
      }

      const options = positions.map(([ticker]) => ({
        label: `${ticker} - ${ASSETS[ticker]?.name || ticker}`,
        value: ticker
      }));

      return interaction.reply({
        content: '**Which asset would you like to sell?**',
        components: [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('sel_sell_asset')
              .setPlaceholder('Choose a position...')
              .addOptions(options)
          )
        ],
        ephemeral: true
      });
    }

    if (interaction.customId === 'btn_prices') {
      await interaction.deferReply({ ephemeral: true });

      const prices = await fetchPrices();

      const lines = Object.entries(ASSETS).map(([ticker, asset]) => {
        const price = prices[ticker];

        return `${ticker.padEnd(7)} ${asset.name.padEnd(18)} ${
          price
            ? `$${price.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 4
              })}`
            : '-'
        }`;
      });

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x1565c0)
            .setTitle('📈 Market Prices')
            .setDescription('```\n' + lines.join('\n') + '\n```')
            .setFooter({
              text: '60-second cache · CoinGecko + Yahoo Finance'
            })
            .setTimestamp()
        ]
      });
    }

    if (interaction.customId === 'btn_ranking') {
      await interaction.deferReply({ ephemeral: true });

      return interaction.editReply({
        embeds: [await rankingEmbed()]
      });
    }

    if (interaction.customId.startsWith('sell_all_')) {
      await interaction.deferReply({ ephemeral: true });

      const ticker = interaction.customId.replace('sell_all_', '');
      const user = await ensureUser(interaction.user.id);
      const position = user.positions[ticker];

      if (!position || position.qty <= 0) {
        return interaction.editReply({
          content: `❌ No open position in ${ticker}.`
        });
      }

      const prices = await fetchPrices();
      const price = prices[ticker];

      if (!price) {
        return interaction.editReply({
          content: '❌ Price unavailable.'
        });
      }

      const received = position.qty * price;

      user.capital += received;
      delete user.positions[ticker];

      await saveData();

      return interaction.editReply({
        content:
          `✅ **${ticker}** sold in full for **$${received.toFixed(2)}**\n` +
          `Available cash: **$${user.capital.toFixed(2)}**`
      });
    }

    if (interaction.customId.startsWith('modal_sell_partial_')) {
      const ticker = interaction.customId.replace(
        'modal_sell_partial_', ''
      );

      const modal = new ModalBuilder()
        .setCustomId(`modal_sell_${ticker}`)
        .setTitle(`Sell ${ticker}`)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('montant')
              .setLabel('USD amount to sell')
              .setPlaceholder('USD amount to sell (e.g. 200)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );

      return interaction.showModal(modal);
    }
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'sel_buy_asset') {
      const ticker = interaction.values[0];

      const modal = new ModalBuilder()
        .setCustomId(`modal_buy_${ticker}`)
        .setTitle(`Buy ${ticker}`)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('montant')
              .setLabel('USD amount to invest')
              .setPlaceholder('USD amount to invest (e.g. 500)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );

      return interaction.showModal(modal);
    }

    if (interaction.customId === 'sel_sell_asset') {
      const ticker = interaction.values[0];
      const user = getUser(interaction.user.id);
      const price = priceCache[ticker];
      const position = user?.positions[ticker];

      if (!position || position.qty <= 0) {
        return interaction.reply({
          content: `❌ No open position in ${ticker}.`,
          ephemeral: true
        });
      }

      const value = position.qty * (price || position.avg_price);

      return interaction.reply({
        content:
          `**${ticker}** · ${position.qty.toFixed(6)} units · ` +
          `value ≈ **$${value.toFixed(2)}** · ` +
          `price $${price?.toFixed(2) || '-'}`,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`sell_all_${ticker}`)
              .setLabel(`Sell all (≈$${value.toFixed(0)})`)
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId(`modal_sell_partial_${ticker}`)
              .setLabel('Sell a specific amount')
              .setStyle(ButtonStyle.Secondary)
          )
        ],
        ephemeral: true
      });
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('modal_buy_')) {
      await interaction.deferReply({ ephemeral: true });

      const ticker = interaction.customId.replace('modal_buy_', '');
      const amount = Number(
        interaction.fields.getTextInputValue('montant').trim()
      );

      if (!Number.isFinite(amount) || amount <= 0) {
        return interaction.editReply({
          content: '❌ Invalid amount. Enter a positive USD amount.'
        });
      }

      const user = await ensureUser(interaction.user.id);

      if (user.capital < amount) {
        return interaction.editReply({
          content: `❌ Insufficient cash. You have **$${user.capital.toFixed(2)}**.`
        });
      }

      const prices = await fetchPrices();
      const price = prices[ticker];

      if (!price) {
        return interaction.editReply({
          content: `❌ Price unavailable for ${ticker}.`
        });
      }

      const quantity = amount / price;
      user.capital -= amount;

      if (!user.positions[ticker]) {
        user.positions[ticker] = { qty: 0, avg_price: price };
      }

      const position = user.positions[ticker];
      const newQuantity = position.qty + quantity;

      position.avg_price = (
        (position.qty * position.avg_price) +
        (quantity * price)
      ) / newQuantity;

      position.qty = newQuantity;

      await saveData();

      return interaction.editReply({
        content:
          `✅ **${ticker}** bought for **$${amount.toFixed(2)}** at $${price.toFixed(4)}\n` +
          `Remaining cash: **$${user.capital.toFixed(2)}**`
      });
    }

    if (interaction.customId.startsWith('modal_sell_')) {
      await interaction.deferReply({ ephemeral: true });

      const ticker = interaction.customId.replace('modal_sell_', '');
      const amount = Number(
        interaction.fields.getTextInputValue('montant').trim()
      );

      if (!Number.isFinite(amount) || amount <= 0) {
        return interaction.editReply({
          content: '❌ Invalid amount. Enter a positive USD amount.'
        });
      }

      const user = await ensureUser(interaction.user.id);
      const prices = await fetchPrices();
      const price = prices[ticker];

      if (!price) {
        return interaction.editReply({
          content: '❌ Price unavailable.'
        });
      }

      const position = user.positions[ticker];

      if (!position || position.qty <= 0) {
        return interaction.editReply({
          content: `❌ No open position in ${ticker}.`
        });
      }

      const quantityToSell = amount / price;
      const maxValue = position.qty * price;

      if (amount > maxValue) {
        return interaction.editReply({
          content: `❌ Maximum sell value: **$${maxValue.toFixed(2)}**`
        });
      }

      position.qty -= quantityToSell;

      if (position.qty <= Number.EPSILON) {
        delete user.positions[ticker];
      }

      user.capital += amount;

      await saveData();

      return interaction.editReply({
        content:
          `✅ **${ticker}** sold for **$${amount.toFixed(2)}**\n` +
          `Available cash: **$${user.capital.toFixed(2)}**`
      });
    }
  }
}

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.guildId !== GUILD_ID) return;

  if (!ready) {
    return interaction.reply({
      content: 'The bot is starting. Please try again shortly.',
      ephemeral: true
    });
  }

  if (
    interaction.isChatInputCommand() &&
    !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  ) {
    return interaction.reply({
      content: 'Administrator permission is required.',
      ephemeral: true
    });
  }

  const opensModal =
    (
      interaction.isStringSelectMenu() &&
      interaction.customId === 'sel_buy_asset'
    ) ||
    (
      interaction.isButton() &&
      interaction.customId.startsWith('modal_sell_partial_')
    );

  const run = async () => {
    const snapshot = JSON.stringify(dbRows);

    try {
      await handleInteraction(interaction);
    } catch (_) {
      dbRows = JSON.parse(snapshot);

      console.error(
        'Interaction failed. Check storage permissions and market data availability.'
      );

      const payload = {
        content: 'Unable to complete this action. Please try again shortly.',
        components: [],
        embeds: []
      };

      try {
        if (interaction.deferred) {
          await interaction.editReply(payload);
        } else if (!interaction.replied) {
          await interaction.reply({ ...payload, ephemeral: true });
        }
      } catch (_) {}
    }
  };

  try {
    if (opensModal) {
      if (!getUser(interaction.user.id)) {
        return interaction.reply({
          content: 'Click Portfolio or Buy to start trading.',
          ephemeral: true
        });
      }

      await run();
    } else {
      const publicReply =
        interaction.isChatInputCommand() &&
        ['ranking', 'winner'].includes(interaction.commandName);

      await interaction.deferReply({ ephemeral: !publicReply });

      interaction.deferReply = async () => {};
      interaction.reply = payload => interaction.editReply(payload);

      mutationQueue = mutationQueue.then(run, run);
      await mutationQueue;
    }
  } catch (_) {
    console.error('Unable to acknowledge interaction.');
  }
});

function scheduleDaily() {
  let lastPostedDate = '';

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });

  setInterval(() => {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date())
        .map(part => [part.type, part.value])
    );

    const date = `${parts.year}-${parts.month}-${parts.day}`;

    if (
      parts.hour !== '09' ||
      parts.minute !== '00' ||
      date === lastPostedDate
    ) return;

    lastPostedDate = date;

    mutationQueue = mutationQueue.then(async () => {
      try {
        const channel = await client.channels.fetch(RANK_CHANNEL_ID);

        await channel.send({
          content: '☀️ **Morning Rankings!**',
          embeds: [await rankingEmbed()],
          allowedMentions: { parse: [] }
        });
      } catch (_) {
        console.error(
          'Daily ranking failed. Check channel permissions and price availability.'
        );
      }
    });
  }, 15000);

  console.log('Daily rankings scheduled for 9 AM Europe/Paris.');
}

client.login(TOKEN).catch(() => {
  console.error('Discord login failed. Check TOKEN.');
  process.exitCode = 1;
});
