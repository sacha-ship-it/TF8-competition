// ════════════════════════════════════════════════════════════════════════════
//  TF8 TRADING COMPETITION BOT
//  Stockage : CSV dans un message Discord (canal log privé)
//  Membres  : tout par boutons, zéro slash command
//  Admins   : /setup-trading /reset-competition /classement /liste-emails /gagnant
// ════════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  EmbedBuilder, Events, SlashCommandBuilder,
  REST, Routes, PermissionFlagsBits
} = require('discord.js');
const axios = require('axios');

// ─── VARIABLES D'ENVIRONNEMENT ───────────────────────────────────────────────
const TOKEN            = process.env.TOKEN;
const CLIENT_ID        = process.env.CLIENT_ID;
const GUILD_ID         = process.env.GUILD_ID;
const LOG_CHANNEL_ID   = process.env.LOG_CHANNEL_ID;
const EMAIL_CHANNEL_ID = process.env.EMAIL_CHANNEL_ID;
const RANK_CHANNEL_ID  = process.env.RANK_CHANNEL_ID;

const STARTING_CAPITAL = 10000;

// ─── 20 ACTIFS ───────────────────────────────────────────────────────────────
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

// ─── PRIX TEMPS RÉEL ─────────────────────────────────────────────────────────
let priceCache = {};
let lastFetch = 0;

async function fetchPrices() {
  if (Date.now() - lastFetch < 60_000) return priceCache;
  const prices = {};

  // Crypto → CoinGecko (gratuit, sans clé)
  const cryptoIds = [...new Set(
    Object.values(ASSETS).filter(a => a.source === 'crypto').map(a => a.id)
  )].join(',');
  try {
    const r = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${cryptoIds}&vs_currencies=usd`,
      { timeout: 8000 }
    );
    for (const [ticker, asset] of Object.entries(ASSETS)) {
      if (asset.source === 'crypto' && r.data[asset.id]) prices[ticker] = r.data[asset.id].usd;
    }
  } catch (e) { console.error('CoinGecko error:', e.message); }

  // Actions/ETF/Forex → Yahoo Finance (sans clé)
  const yahooTickers = Object.entries(ASSETS).filter(([, a]) => a.source === 'yahoo');
  for (const [ticker, asset] of yahooTickers) {
    try {
      const r = await axios.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${asset.id}?interval=1d&range=1d`,
        { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const meta = r.data?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice || meta?.previousClose;
      if (price) prices[ticker] = price;
    } catch (_) {}
  }

  priceCache = { ...priceCache, ...prices };
  lastFetch = Date.now();
  return priceCache;
}

// ─── BASE DE DONNÉES (CSV dans un message Discord) ───────────────────────────
let logMessage = null;
let dbRows = [];

async function loadData(client) {
  const ch = await client.channels.fetch(LOG_CHANNEL_ID);
  const msgs = await ch.messages.fetch({ limit: 20 });
  logMessage = msgs.find(m => m.author.id === client.user.id && m.content.startsWith('```csv'));
  if (!logMessage) {
    logMessage = await ch.send('```csv\ndiscord_id,email,capital,positions,joined_at\n```');
  }
  dbRows = parseCSV(logMessage.content);
}

function parseCSV(raw) {
  const lines = raw.replace(/```csv\n/, '').replace(/\n```/, '').trim().split('\n');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const [discord_id, email, capital, positions, joined_at] = lines[i].split(',');
    let pos = {};
    try { pos = positions ? JSON.parse(Buffer.from(positions, 'base64').toString()) : {}; } catch (_) {}
    rows.push({ discord_id, email: email || '', capital: parseFloat(capital) || STARTING_CAPITAL, positions: pos, joined_at: joined_at || '' });
  }
  return rows;
}

async function saveData() {
  const lines = ['discord_id,email,capital,positions,joined_at'];
  for (const r of dbRows) {
    const pos = Buffer.from(JSON.stringify(r.positions || {})).toString('base64');
    lines.push(`${r.discord_id},${r.email},${r.capital.toFixed(2)},${pos},${r.joined_at}`);
  }
  const content = '```csv\n' + lines.join('\n') + '\n```';
  if (content.length > 1990) {
    const ch = logMessage.channel;
    const nm = await ch.send(content);
    await logMessage.delete().catch(() => {});
    logMessage = nm;
  } else {
    logMessage = await logMessage.edit(content);
  }
}

function getUser(id) { return dbRows.find(r => r.discord_id === id); }
function createUser(id, email) {
  const u = { discord_id: id, email, capital: STARTING_CAPITAL, positions: {}, joined_at: new Date().toISOString().split('T')[0] };
  dbRows.push(u);
  return u;
}

// ─── CLASSEMENT ───────────────────────────────────────────────────────────────
async function getRanked(prices) {
  if (!prices) prices = await fetchPrices();
  return dbRows.map(u => {
    let inv = 0;
    for (const [ticker, pos] of Object.entries(u.positions || {})) {
      if (prices[ticker]) inv += pos.qty * prices[ticker];
    }
    return { discord_id: u.discord_id, total: u.capital + inv };
  }).sort((a, b) => b.total - a.total);
}

async function rankingEmbed() {
  const prices = await fetchPrices();
  const ranked = await getRanked(prices);
  const medals = ['🥇', '🥈', '🥉'];
  const lines = ranked.slice(0, 15).map((r, i) => {
    const pnl = r.total - STARTING_CAPITAL;
    const pct = ((pnl / STARTING_CAPITAL) * 100).toFixed(2);
    const sign = pnl >= 0 ? '+' : '';
    return `${medals[i] || `\`${i + 1}.\``} <@${r.discord_id}> — **$${r.total.toFixed(0)}** (${sign}${pct}%)`;
  });
  return new EmbedBuilder()
    .setColor(0xf9a825)
    .setTitle('🏆 Classement TF8 Trading Competition')
    .setDescription(lines.length ? lines.join('\n') : 'Aucun participant pour l\'instant.')
    .setFooter({ text: `${ranked.length} participants · Capital de départ $${STARTING_CAPITAL.toLocaleString()}` })
    .setTimestamp();
}

// ─── PORTFOLIO EMBED ──────────────────────────────────────────────────────────
async function portfolioEmbed(user, member) {
  const prices = await fetchPrices();
  let invested = 0;
  const posLines = [];

  for (const [ticker, pos] of Object.entries(user.positions || {})) {
    if (pos.qty <= 0) continue;
    const price = prices[ticker];
    if (!price) continue;
    const val = pos.qty * price;
    const cost = pos.qty * pos.avg_price;
    const pnl = val - cost;
    const pct = ((pnl / cost) * 100).toFixed(2);
    invested += val;
    posLines.push(`${pnl >= 0 ? '🟢' : '🔴'} **${ticker}** · $${val.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pct}%)`);
  }

  const total = user.capital + invested;
  const globalPnl = total - STARTING_CAPITAL;
  const globalPct = ((globalPnl / STARTING_CAPITAL) * 100).toFixed(2);
  const ranked = await getRanked(prices);
  const rank = ranked.findIndex(r => r.discord_id === user.discord_id) + 1;

  return new EmbedBuilder()
    .setColor(globalPnl >= 0 ? 0x00c853 : 0xff1744)
    .setTitle(`📊 Portfolio de ${member.displayName}`)
    .addFields(
      { name: '💰 Capital total', value: `**$${total.toFixed(2)}**`, inline: true },
      { name: '📈 Performance', value: `**${globalPnl >= 0 ? '+' : ''}${globalPct}%**`, inline: true },
      { name: '🏆 Rang', value: `**#${rank}** / ${ranked.length}`, inline: true },
      { name: '💵 Cash dispo', value: `$${user.capital.toFixed(2)}`, inline: true },
      { name: '📦 Investi', value: `$${invested.toFixed(2)}`, inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: `Positions (${posLines.length})`, value: posLines.length ? posLines.join('\n') : '_Aucune — clique sur **💸 Acheter** pour commencer_' }
    )
    .setFooter({ text: 'TF8 Trading Competition · Prix temps réel' })
    .setTimestamp();
}

// ─── BOUTONS PRINCIPAUX ───────────────────────────────────────────────────────
function mainMenuRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_portfolio').setLabel('📊 Portfolio').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_buy_menu').setLabel('💸 Acheter').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('btn_sell_menu').setLabel('📤 Vendre').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('btn_prices').setLabel('📈 Prix').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_ranking').setLabel('🏆 Classement').setStyle(ButtonStyle.Secondary)
  );
}

function assetSelectMenu(customId, placeholder) {
  const options = Object.entries(ASSETS).map(([ticker, asset]) => ({
    label: `${ticker} — ${asset.name}`,
    value: ticker
  }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addOptions(options)
  );
}

// ─── SLASH COMMANDS ADMIN ─────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('setup-trading')
    .setDescription('[Admin] Poster le panneau Trading Competition dans ce canal')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('classement')
    .setDescription('[Admin] Poster le classement maintenant')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('reset-competition')
    .setDescription('[Admin] Remettre tous les portfolios à zéro ($10 000)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('liste-emails')
    .setDescription('[Admin] Voir les emails des inscrits')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('gagnant')
    .setDescription('[Admin] Afficher le gagnant de la compétition')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(c => c.toJSON());

// ─── CLIENT ──────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel]
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ Connecté : ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('✅ Commandes admin enregistrées');
  await loadData(client);
  console.log(`✅ ${dbRows.length} participants chargés`);
  scheduleDaily();
});

// ─── INSCRIPTION PAR EMAIL ────────────────────────────────────────────────────
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;
  if (msg.channelId !== EMAIL_CHANNEL_ID) return;

  const email = msg.content.trim();
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  if (!emailOk) {
    const r = await msg.reply('❌ Format invalide. Envoie uniquement ton adresse email (ex: `nom@gmail.com`)');
    setTimeout(() => r.delete().catch(() => {}), 8000);
    await msg.delete().catch(() => {});
    return;
  }

  let user = getUser(msg.author.id);
  if (user) {
    user.email = email;
    await saveData();
    const r = await msg.reply(`✅ Email mis à jour ! Tu participes à la **TF8 Trading Competition** avec $${STARTING_CAPITAL.toLocaleString()} virtuels.`);
    setTimeout(() => r.delete().catch(() => {}), 10000);
  } else {
    user = createUser(msg.author.id, email);
    await saveData();
    const r = await msg.reply(`🎯 **Inscription confirmée !** Tu démarres avec **$${STARTING_CAPITAL.toLocaleString()}** virtuels.\nRetourne dans le canal Trading et clique sur **📊 Portfolio** pour voir ton dashboard !`);
    setTimeout(() => r.delete().catch(() => {}), 12000);
  }
  await msg.delete().catch(() => {});
});

// ─── INTERACTIONS ─────────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {

  // ══ SLASH COMMANDS ══
  if (interaction.isChatInputCommand()) {

    if (interaction.commandName === 'setup-trading') {
      const embed = new EmbedBuilder()
        .setColor(0x1565c0)
        .setTitle('📈 TF8 Trading Competition')
        .setDescription(
          '**Trading virtuel. Vrais prix. Vrai classement.**\n\n' +
          'Tu démarres avec **$10 000 virtuels** à investir sur 20 actifs réels.\n' +
          'BTC, ETH, Tesla, NVIDIA, S&P 500, Gold, Forex et bien plus.\n' +
          'Les prix sont récupérés en temps réel. Le meilleur trader du mois remporte une récompense TF8.\n\n' +
          `> 📧 **Étape 1** — Envoie ton email dans <#${EMAIL_CHANNEL_ID}> pour t'inscrire\n` +
          '> 📊 **Étape 2** — Utilise les boutons ci-dessous pour trader'
        )
        .setFooter({ text: 'TF8 Trading Competition · Classement mis à jour chaque matin à 9h' });

      await interaction.channel.send({ embeds: [embed], components: [mainMenuRow()] });
      return interaction.reply({ content: '✅ Panneau posté.', ephemeral: true });
    }

    if (interaction.commandName === 'classement') {
      await interaction.deferReply();
      return interaction.editReply({ embeds: [await rankingEmbed()] });
    }

    if (interaction.commandName === 'reset-competition') {
      await interaction.deferReply({ ephemeral: true });
      for (const r of dbRows) { r.capital = STARTING_CAPITAL; r.positions = {}; }
      await saveData();
      return interaction.editReply({ content: `✅ ${dbRows.length} portfolios remis à zéro ($${STARTING_CAPITAL.toLocaleString()}).` });
    }

    if (interaction.commandName === 'liste-emails') {
      await interaction.deferReply({ ephemeral: true });
      if (!dbRows.length) return interaction.editReply({ content: 'Aucun inscrit.' });
      const lines = dbRows.map((r, i) => `${i + 1}. <@${r.discord_id}> — \`${r.email || '—'}\` (inscrit le ${r.joined_at})`).join('\n');
      return interaction.editReply({ content: `**${dbRows.length} inscrits :**\n${lines}` });
    }

    if (interaction.commandName === 'gagnant') {
      await interaction.deferReply();
      const ranked = await getRanked();
      if (!ranked.length) return interaction.editReply({ content: 'Aucun participant.' });
      const w = ranked[0];
      const pnl = w.total - STARTING_CAPITAL;
      const pct = ((pnl / STARTING_CAPITAL) * 100).toFixed(2);
      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(0xffd700)
          .setTitle('🏆 Gagnant de la TF8 Trading Competition !')
          .setDescription(`🥇 <@${w.discord_id}>\n\n**Capital final : $${w.total.toFixed(2)}**\nPerformance : **+${pct}%**`)
          .setTimestamp()]
      });
    }
  }

  // ══ BOUTONS ══
  if (interaction.isButton()) {

    // 📊 Portfolio
    if (interaction.customId === 'btn_portfolio') {
      await interaction.deferReply({ ephemeral: true });
      const user = getUser(interaction.user.id);
      if (!user) return interaction.editReply({ content: `❌ Tu n'es pas inscrit. Envoie ton email dans <#${EMAIL_CHANNEL_ID}>.` });
      return interaction.editReply({ embeds: [await portfolioEmbed(user, interaction.member)] });
    }

    // 💸 Acheter → sélecteur actif
    if (interaction.customId === 'btn_buy_menu') {
      const user = getUser(interaction.user.id);
      if (!user) return interaction.reply({ content: `❌ Inscris-toi d'abord dans <#${EMAIL_CHANNEL_ID}>.`, ephemeral: true });
      return interaction.reply({
        content: `**Quel actif veux-tu acheter ?**\nCash disponible : **$${user.capital.toFixed(2)}**`,
        components: [assetSelectMenu('sel_buy_asset', 'Choisir un actif…')],
        ephemeral: true
      });
    }

    // 📤 Vendre → sélecteur positions
    if (interaction.customId === 'btn_sell_menu') {
      const user = getUser(interaction.user.id);
      if (!user) return interaction.reply({ content: `❌ Inscris-toi d'abord dans <#${EMAIL_CHANNEL_ID}>.`, ephemeral: true });
      const openPos = Object.entries(user.positions || {}).filter(([, p]) => p.qty > 0);
      if (!openPos.length) return interaction.reply({ content: '❌ Tu n\'as aucune position ouverte.', ephemeral: true });
      const options = openPos.map(([t]) => ({ label: `${t} — ${ASSETS[t]?.name || t}`, value: t }));
      return interaction.reply({
        content: '**Quel actif veux-tu vendre ?**',
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('sel_sell_asset').setPlaceholder('Choisir une position…').addOptions(options)
        )],
        ephemeral: true
      });
    }

    // 📈 Prix
    if (interaction.customId === 'btn_prices') {
      await interaction.deferReply({ ephemeral: true });
      const prices = await fetchPrices();
      const lines = Object.entries(ASSETS).map(([t, a]) => {
        const p = prices[t];
        return `\`${t.padEnd(7)}\` ${a.name.padEnd(18)} ${p ? `$${p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}` : '—'}`;
      });
      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(0x1565c0)
          .setTitle('📈 Prix en temps réel')
          .setDescription('```\n' + lines.join('\n') + '\n```')
          .setFooter({ text: 'Cache 60s · CoinGecko + Yahoo Finance' })
          .setTimestamp()]
      });
    }

    // 🏆 Classement
    if (interaction.customId === 'btn_ranking') {
      await interaction.deferReply({ ephemeral: true });
      return interaction.editReply({ embeds: [await rankingEmbed()] });
    }

    // Vendre tout (bouton dynamique)
    if (interaction.customId.startsWith('sell_all_')) {
      await interaction.deferReply({ ephemeral: true });
      const ticker = interaction.customId.replace('sell_all_', '');
      const user = getUser(interaction.user.id);
      if (!user) return interaction.editReply({ content: '❌ Non inscrit.' });
      const pos = user.positions[ticker];
      if (!pos || pos.qty <= 0) return interaction.editReply({ content: `❌ Pas de position sur ${ticker}.` });
      const prices = await fetchPrices();
      const price = prices[ticker];
      if (!price) return interaction.editReply({ content: `❌ Prix indisponible.` });
      const received = pos.qty * price;
      user.capital += received;
      delete user.positions[ticker];
      await saveData();
      return interaction.editReply({ content: `✅ **${ticker}** vendu entièrement pour **$${received.toFixed(2)}**\nCash total : **$${user.capital.toFixed(2)}**` });
    }

    // Bouton pour ouvrir modal vente partielle
    if (interaction.customId.startsWith('modal_sell_partial_')) {
      const ticker = interaction.customId.replace('modal_sell_partial_', '');
      const user = getUser(interaction.user.id);
      const prices = await fetchPrices();
      const price = prices[ticker];
      const pos = user?.positions[ticker];
      const modal = new ModalBuilder()
        .setCustomId(`modal_sell_${ticker}`)
        .setTitle(`Vendre ${ticker} — ${ASSETS[ticker]?.name}`)
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('montant')
            .setLabel(`Valeur pos. : $${(pos?.qty * (price || 0)).toFixed(2)} · Prix : $${price?.toFixed(2) || '—'}`)
            .setPlaceholder('Montant en USD à vendre (ex: 200)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ));
      return interaction.showModal(modal);
    }
  }

  // ══ SELECT MENUS ══
  if (interaction.isStringSelectMenu()) {

    // Achat : sélection actif → modal montant
    if (interaction.customId === 'sel_buy_asset') {
      const ticker = interaction.values[0];
      const prices = await fetchPrices();
      const price = prices[ticker];
      const user = getUser(interaction.user.id);
      const modal = new ModalBuilder()
        .setCustomId(`modal_buy_${ticker}`)
        .setTitle(`Acheter ${ticker} — ${ASSETS[ticker]?.name}`)
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('montant')
            .setLabel(`Prix : $${price ? price.toFixed(2) : '—'} · Cash dispo : $${user?.capital.toFixed(2) || 0}`)
            .setPlaceholder('Montant en USD à investir (ex: 500)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ));
      return interaction.showModal(modal);
    }

    // Vente : sélection actif → boutons "Tout vendre" ou "Montant précis"
    if (interaction.customId === 'sel_sell_asset') {
      const ticker = interaction.values[0];
      const user = getUser(interaction.user.id);
      const prices = await fetchPrices();
      const price = prices[ticker];
      const pos = user?.positions[ticker];
      if (!pos || pos.qty <= 0) return interaction.reply({ content: `❌ Pas de position sur ${ticker}.`, ephemeral: true });
      const valeur = pos.qty * (price || pos.avg_price);
      return interaction.reply({
        content: `**${ticker}** · ${pos.qty.toFixed(6)} unités · valeur ≈ **$${valeur.toFixed(2)}** · prix $${price?.toFixed(2) || '—'}`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`sell_all_${ticker}`).setLabel(`Tout vendre (≈$${valeur.toFixed(0)})`).setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`modal_sell_partial_${ticker}`).setLabel('Vendre un montant précis').setStyle(ButtonStyle.Secondary)
        )],
        ephemeral: true
      });
    }
  }

  // ══ MODALS ══
  if (interaction.isModalSubmit()) {

    // Achat
    if (interaction.customId.startsWith('modal_buy_')) {
      await interaction.deferReply({ ephemeral: true });
      const ticker = interaction.customId.replace('modal_buy_', '');
      const montant = parseFloat(interaction.fields.getTextInputValue('montant'));
      if (isNaN(montant) || montant <= 0) return interaction.editReply({ content: '❌ Montant invalide.' });
      const user = getUser(interaction.user.id);
      if (!user) return interaction.editReply({ content: '❌ Non inscrit.' });
      if (user.capital < montant) return interaction.editReply({ content: `❌ Cash insuffisant. Tu as **$${user.capital.toFixed(2)}**.` });
      const prices = await fetchPrices();
      const price = prices[ticker];
      if (!price) return interaction.editReply({ content: `❌ Prix indisponible pour ${ticker}.` });
      const qty = montant / price;
      user.capital -= montant;
      if (!user.positions[ticker]) user.positions[ticker] = { qty: 0, avg_price: price };
      const pos = user.positions[ticker];
      const newQty = pos.qty + qty;
      pos.avg_price = ((pos.qty * pos.avg_price) + (qty * price)) / newQty;
      pos.qty = newQty;
      await saveData();
      return interaction.editReply({ content: `✅ **${ticker}** acheté pour **$${montant.toFixed(2)}** à $${price.toFixed(4)}\nCash restant : **$${user.capital.toFixed(2)}**` });
    }

    // Vente partielle
    if (interaction.customId.startsWith('modal_sell_')) {
      await interaction.deferReply({ ephemeral: true });
      const ticker = interaction.customId.replace('modal_sell_', '');
      const montant = parseFloat(interaction.fields.getTextInputValue('montant'));
      if (isNaN(montant) || montant <= 0) return interaction.editReply({ content: '❌ Montant invalide.' });
      const user = getUser(interaction.user.id);
      if (!user) return interaction.editReply({ content: '❌ Non inscrit.' });
      const prices = await fetchPrices();
      const price = prices[ticker];
      if (!price) return interaction.editReply({ content: `❌ Prix indisponible.` });
      const pos = user.positions[ticker];
      if (!pos || pos.qty <= 0) return interaction.editReply({ content: `❌ Pas de position sur ${ticker}.` });
      const qtyToSell = montant / price;
      const maxVal = pos.qty * price;
      if (montant > maxVal + 0.01) return interaction.editReply({ content: `❌ Maximum vendable : **$${maxVal.toFixed(2)}**` });
      pos.qty -= qtyToSell;
      if (pos.qty < 0.000001) delete user.positions[ticker];
      user.capital += montant;
      await saveData();
      return interaction.editReply({ content: `✅ **${ticker}** vendu pour **$${montant.toFixed(2)}**\nCash total : **$${user.capital.toFixed(2)}**` });
    }
  }
});

// ─── CLASSEMENT AUTO 9H PARIS ─────────────────────────────────────────────────
function scheduleDaily() {
  const now = new Date();
  const next = new Date();
  next.setHours(9, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  setTimeout(async () => {
    const post = async () => {
      try {
        const ch = await client.channels.fetch(RANK_CHANNEL_ID);
        await ch.send({ content: '☀️ **Classement du matin !**', embeds: [await rankingEmbed()] });
      } catch (e) { console.error('Erreur classement auto:', e); }
    };
    await post();
    setInterval(post, 24 * 60 * 60 * 1000);
  }, delay);
  console.log(`✅ Classement auto dans ${Math.round(delay / 60000)} min`);
}

client.login(TOKEN);
