/*
  Single-file Discord bot (Node.js + discord.js)
  Start:
    1) npm i discord.js
    2) set DISCORD_TOKEN=...   (Windows PowerShell)
       optional: set CLIENT_ID=..., set GUILD_ID=...
    3) node index.js
*/

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

let djs;
try {
  djs = require('discord.js');
} catch (err) {
  console.error('discord.js fehlt. Bitte zuerst installieren: npm i discord.js');
  process.exit(1);
}

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  AuditLogEvent,
} = djs;

const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

if (!TOKEN) {
  console.error('Fehlende Umgebungsvariable: DISCORD_TOKEN');
  process.exit(1);
}

const DATA_FILE = path.join(process.cwd(), 'bot-data.json');
const DASHBOARD_FILE = path.join(process.cwd(), 'dashboard.html');

const DEFAULT_GUILD = {
  prefix: '!',
  staffRoleId: null,
  mutedRoleId: null,
  modLogChannelId: null,
  welcomeChannelId: null,
  leaveChannelId: null,
  suggestionChannelId: null,
  ticketCategoryId: null,
  autoroleId: null,
  automod: {
    enabled: true,
    antiInvite: true,
    antiLink: false,
    spamMax: 6,
    spamWindowMs: 8000,
    badWords: ['beleidigung1', 'beleidigung2'],
  },
  warnings: {},
};

let store = { guilds: {}, reactionRolePanels: {} };

function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      store = JSON.parse(raw);
    }
  } catch (err) {
    console.error('Konnte bot-data.json nicht lesen, nutze Defaults.', err.message);
  }
}

function saveStore() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function getGuildConfig(guildId) {
  if (!store.guilds[guildId]) {
    store.guilds[guildId] = JSON.parse(JSON.stringify(DEFAULT_GUILD));
    saveStore();
  }
  const cfg = store.guilds[guildId];
  cfg.automod = { ...DEFAULT_GUILD.automod, ...(cfg.automod || {}) };
  cfg.warnings = cfg.warnings || {};
  return cfg;
}

function hasStaff(member, cfg) {
  if (!member) return false;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  if (cfg.staffRoleId && member.roles.cache.has(cfg.staffRoleId)) return true;
  return false;
}

function escapeText(text = '') {
  return text.replace(/[`*_~|>]/g, '\\$&').slice(0, 1000);
}

async function logToModChannel(guild, cfg, embed) {
  if (!cfg.modLogChannelId) return;
  const ch = guild.channels.cache.get(cfg.modLogChannelId);
  if (!ch || !ch.isTextBased()) return;
  try {
    await ch.send({ embeds: [embed] });
  } catch {}
}

function parseDuration(input) {
  if (!input) return null;
  const match = /^([0-9]+)\s*(s|m|h|d)$/i.exec(input.trim());
  if (!match) return null;
  const n = Number(match[1]);
  const u = match[2].toLowerCase();
  const map = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return n * map[u];
}

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Zeigt die Bot-Latenz.'),

  new SlashCommandBuilder()
    .setName('mod')
    .setDescription('Strukturierte Moderationsbefehle.')
    .addSubcommand((s) => s.setName('warn').setDescription('Warnt ein Mitglied.').addUserOption((o) => o.setName('user').setDescription('Ziel').setRequired(true)).addStringOption((o) => o.setName('reason').setDescription('Grund').setRequired(false)))
    .addSubcommand((s) => s.setName('warnings').setDescription('Zeigt Warnungen eines Mitglieds.').addUserOption((o) => o.setName('user').setDescription('Ziel').setRequired(true)))
    .addSubcommand((s) => s.setName('clearwarnings').setDescription('Löscht alle Warnungen eines Mitglieds.').addUserOption((o) => o.setName('user').setDescription('Ziel').setRequired(true)))
    .addSubcommand((s) => s.setName('kick').setDescription('Kickt ein Mitglied.').addUserOption((o) => o.setName('user').setDescription('Ziel').setRequired(true)).addStringOption((o) => o.setName('reason').setDescription('Grund').setRequired(false)))
    .addSubcommand((s) => s.setName('ban').setDescription('Bannt ein Mitglied.').addUserOption((o) => o.setName('user').setDescription('Ziel').setRequired(true)).addIntegerOption((o) => o.setName('delete_days').setDescription('Lösche Nachrichten der letzten X Tage (0-7)').setRequired(false).setMinValue(0).setMaxValue(7)).addStringOption((o) => o.setName('reason').setDescription('Grund').setRequired(false)))
    .addSubcommand((s) => s.setName('unban').setDescription('Entbannt per User-ID.').addStringOption((o) => o.setName('userid').setDescription('User ID').setRequired(true)).addStringOption((o) => o.setName('reason').setDescription('Grund').setRequired(false)))
    .addSubcommand((s) => s.setName('timeout').setDescription('Setzt Timeout auf ein Mitglied.').addUserOption((o) => o.setName('user').setDescription('Ziel').setRequired(true)).addStringOption((o) => o.setName('dauer').setDescription('z.B. 10m, 2h, 1d').setRequired(true)).addStringOption((o) => o.setName('reason').setDescription('Grund').setRequired(false)))
    .addSubcommand((s) => s.setName('untimeout').setDescription('Entfernt Timeout von Mitglied.').addUserOption((o) => o.setName('user').setDescription('Ziel').setRequired(true)).addStringOption((o) => o.setName('reason').setDescription('Grund').setRequired(false)))
    .addSubcommand((s) => s.setName('purge').setDescription('Löscht bis zu 100 Nachrichten.').addIntegerOption((o) => o.setName('amount').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100)))
    .addSubcommand((s) => s.setName('slowmode').setDescription('Setzt Slowmode in Sekunden (0-21600).').addIntegerOption((o) => o.setName('seconds').setDescription('Sekunden').setRequired(true).setMinValue(0).setMaxValue(21600)))
    .addSubcommand((s) => s.setName('lock').setDescription('Sperrt den aktuellen Kanal.'))
    .addSubcommand((s) => s.setName('unlock').setDescription('Entsperrt den aktuellen Kanal.')),

  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Strukturierte Server-Konfiguration.')
    .addSubcommand((s) => s.setName('log').setDescription('Setzt Moderations-Log Channel').addChannelOption((o) => o.setName('channel').setDescription('Log Channel').setRequired(true)))
    .addSubcommand((s) => s.setName('welcome').setDescription('Setzt Welcome Channel').addChannelOption((o) => o.setName('channel').setDescription('Welcome Channel').setRequired(true)))
    .addSubcommand((s) => s.setName('leave').setDescription('Setzt Leave Channel').addChannelOption((o) => o.setName('channel').setDescription('Leave Channel').setRequired(true)))
    .addSubcommand((s) => s.setName('suggestions').setDescription('Setzt Suggestions Channel').addChannelOption((o) => o.setName('channel').setDescription('Suggestions Channel').setRequired(true)))
    .addSubcommand((s) => s.setName('ticket-category').setDescription('Setzt Ticket Kategorie').addChannelOption((o) => o.setName('category').setDescription('Kategorie').addChannelTypes(ChannelType.GuildCategory).setRequired(true)))
    .addSubcommand((s) => s.setName('staffrole').setDescription('Setzt Staff Rolle').addRoleOption((o) => o.setName('role').setDescription('Staff Rolle').setRequired(true)))
    .addSubcommand((s) => s.setName('autorole').setDescription('Setzt Auto-Rolle bei Join').addRoleOption((o) => o.setName('role').setDescription('Auto Rolle').setRequired(true)))
    .addSubcommand((s) => s.setName('automod-toggle').setDescription('AutoMod an/aus').addBooleanOption((o) => o.setName('enabled').setDescription('true/false').setRequired(true)))
    .addSubcommand((s) => s.setName('automod-antilink').setDescription('Anti-Link an/aus').addBooleanOption((o) => o.setName('enabled').setDescription('true/false').setRequired(true)))
    .addSubcommand((s) => s.setName('automod-antiinvite').setDescription('Anti-Invite an/aus').addBooleanOption((o) => o.setName('enabled').setDescription('true/false').setRequired(true)))
    .addSubcommand((s) => s.setName('automod-addbadword').setDescription('Fügt ein verbotenes Wort hinzu').addStringOption((o) => o.setName('word').setDescription('Wort').setRequired(true)))
    .addSubcommand((s) => s.setName('automod-removebadword').setDescription('Entfernt ein verbotenes Wort').addStringOption((o) => o.setName('word').setDescription('Wort').setRequired(true))),

  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Setzt zentrale Bot-Konfiguration.')
    .addSubcommand((s) => s.setName('log').setDescription('Setzt Moderations-Log Channel').addChannelOption((o) => o.setName('channel').setDescription('Log Channel').setRequired(true)))
    .addSubcommand((s) => s.setName('welcome').setDescription('Setzt Welcome Channel').addChannelOption((o) => o.setName('channel').setDescription('Welcome Channel').setRequired(true)))
    .addSubcommand((s) => s.setName('leave').setDescription('Setzt Leave Channel').addChannelOption((o) => o.setName('channel').setDescription('Leave Channel').setRequired(true)))
    .addSubcommand((s) => s.setName('suggestions').setDescription('Setzt Suggestions Channel').addChannelOption((o) => o.setName('channel').setDescription('Suggestions Channel').setRequired(true)))
    .addSubcommand((s) => s.setName('ticket-category').setDescription('Setzt Ticket Kategorie').addChannelOption((o) => o.setName('category').setDescription('Kategorie').addChannelTypes(ChannelType.GuildCategory).setRequired(true)))
    .addSubcommand((s) => s.setName('staffrole').setDescription('Setzt Staff Rolle').addRoleOption((o) => o.setName('role').setDescription('Staff Rolle').setRequired(true)))
    .addSubcommand((s) => s.setName('autorole').setDescription('Setzt Auto-Rolle bei Join').addRoleOption((o) => o.setName('role').setDescription('Auto Rolle').setRequired(true))),

  new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Steuert AutoModeration.')
    .addSubcommand((s) => s.setName('toggle').setDescription('AutoMod an/aus').addBooleanOption((o) => o.setName('enabled').setDescription('true/false').setRequired(true)))
    .addSubcommand((s) => s.setName('antilink').setDescription('Anti-Link an/aus').addBooleanOption((o) => o.setName('enabled').setDescription('true/false').setRequired(true)))
    .addSubcommand((s) => s.setName('antiinvite').setDescription('Anti-Invite an/aus').addBooleanOption((o) => o.setName('enabled').setDescription('true/false').setRequired(true)))
    .addSubcommand((s) => s.setName('addbadword').setDescription('Fügt ein verbotenes Wort hinzu').addStringOption((o) => o.setName('word').setDescription('Wort').setRequired(true)))
    .addSubcommand((s) => s.setName('removebadword').setDescription('Entfernt ein verbotenes Wort').addStringOption((o) => o.setName('word').setDescription('Wort').setRequired(true))),

  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Warnt ein Mitglied.')
    .addUserOption((o) => o.setName('user').setDescription('Ziel').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Grund').setRequired(false)),

  new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('Zeigt Warnungen eines Mitglieds.')
    .addUserOption((o) => o.setName('user').setDescription('Ziel').setRequired(true)),

  new SlashCommandBuilder()
    .setName('clearwarnings')
    .setDescription('Löscht alle Warnungen eines Mitglieds.')
    .addUserOption((o) => o.setName('user').setDescription('Ziel').setRequired(true)),

  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kickt ein Mitglied.')
    .addUserOption((o) => o.setName('user').setDescription('Ziel').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Grund').setRequired(false)),

  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Bannt ein Mitglied.')
    .addUserOption((o) => o.setName('user').setDescription('Ziel').setRequired(true))
    .addIntegerOption((o) => o.setName('delete_days').setDescription('Lösche Nachrichten der letzten X Tage (0-7)').setRequired(false).setMinValue(0).setMaxValue(7))
    .addStringOption((o) => o.setName('reason').setDescription('Grund').setRequired(false)),

  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Entbannt per User-ID.')
    .addStringOption((o) => o.setName('userid').setDescription('User ID').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Grund').setRequired(false)),

  new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Setzt Timeout auf ein Mitglied.')
    .addUserOption((o) => o.setName('user').setDescription('Ziel').setRequired(true))
    .addStringOption((o) => o.setName('dauer').setDescription('z.B. 10m, 2h, 1d').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Grund').setRequired(false)),

  new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription('Entfernt Timeout von Mitglied.')
    .addUserOption((o) => o.setName('user').setDescription('Ziel').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Grund').setRequired(false)),

  new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Löscht bis zu 100 Nachrichten.')
    .addIntegerOption((o) => o.setName('amount').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100)),

  new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('Setzt Slowmode in Sekunden (0-21600).')
    .addIntegerOption((o) => o.setName('seconds').setDescription('Sekunden').setRequired(true).setMinValue(0).setMaxValue(21600)),

  new SlashCommandBuilder().setName('lock').setDescription('Sperrt den aktuellen Kanal (Send Messages aus).'),
  new SlashCommandBuilder().setName('unlock').setDescription('Entsperrt den aktuellen Kanal.'),

  new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Sendet eine Ankündigung als Embed.')
    .addStringOption((o) => o.setName('title').setDescription('Titel').setRequired(true))
    .addStringOption((o) => o.setName('text').setDescription('Text').setRequired(true))
    .addChannelOption((o) => o.setName('channel').setDescription('Zielkanal').setRequired(false)),

  new SlashCommandBuilder()
    .setName('suggest')
    .setDescription('Erstellt eine Suggestion.')
    .addStringOption((o) => o.setName('text').setDescription('Vorschlag').setRequired(true)),

  new SlashCommandBuilder().setName('ticketpanel').setDescription('Postet ein Ticket-Button-Panel.'),

  new SlashCommandBuilder().setName('ticketclose').setDescription('Schließt das aktuelle Ticket.'),

  new SlashCommandBuilder()
    .setName('rolepanel')
    .setDescription('Postet ein Rollen-Auswahlpanel (max 5 Rollen).')
    .addRoleOption((o) => o.setName('role1').setDescription('Rolle 1').setRequired(true))
    .addRoleOption((o) => o.setName('role2').setDescription('Rolle 2').setRequired(false))
    .addRoleOption((o) => o.setName('role3').setDescription('Rolle 3').setRequired(false))
    .addRoleOption((o) => o.setName('role4').setDescription('Rolle 4').setRequired(false))
    .addRoleOption((o) => o.setName('role5').setDescription('Rolle 5').setRequired(false)),

  new SlashCommandBuilder().setName('serverinfo').setDescription('Zeigt Serverinfos.'),
  new SlashCommandBuilder().setName('userinfo').setDescription('Zeigt Userinfos.').addUserOption((o) => o.setName('user').setDescription('User').setRequired(false)),
  new SlashCommandBuilder().setName('help').setDescription('Zeigt Bot-Hilfe.'),
].map((c) => c.toJSON());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.GuildMember, Partials.User],
});

const spamMap = new Map();

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getDashboardStatus() {
  const ready = client.isReady();
  return {
    ok: true,
    service: 'discord-bot-dashboard',
    botReady: ready,
    botTag: ready ? client.user.tag : null,
    pingMs: ready ? client.ws.ping : null,
    guilds: ready ? client.guilds.cache.size : 0,
    uptimeSec: Math.floor(process.uptime()),
    now: new Date().toISOString(),
  };
}

function renderDashboardHtml() {
  const status = getDashboardStatus();
  const botState = status.botReady ? 'Online' : 'Starting...';
  const ping = status.pingMs == null ? '-' : `${status.pingMs} ms`;
  const botTag = status.botTag || 'Nicht verbunden';

  try {
    const template = fs.readFileSync(DASHBOARD_FILE, 'utf8');
    return template
      .replace(/\{\{BOT_STATE\}\}/g, escapeHtml(botState))
      .replace(/\{\{BOT_TAG\}\}/g, escapeHtml(botTag))
      .replace(/\{\{GUILDS\}\}/g, escapeHtml(String(status.guilds)))
      .replace(/\{\{PING\}\}/g, escapeHtml(ping))
      .replace(/\{\{UPTIME\}\}/g, escapeHtml(String(status.uptimeSec)))
      .replace(/\{\{NOW\}\}/g, escapeHtml(status.now));
  } catch {}

  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Juhl Network Bot Dashboard</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      font-family: Inter, system-ui, Segoe UI, Arial, sans-serif;
      background: #0b1220;
      color: #e5e7eb;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .card {
      width: min(760px, 100%);
      background: #111827;
      border: 1px solid #1f2937;
      border-radius: 14px;
      padding: 24px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
    }
    h1 { margin: 0 0 8px; font-size: 1.5rem; }
    p { margin: 0 0 18px; color: #9ca3af; }
    .grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      margin-bottom: 16px;
    }
    .item {
      background: #0f172a;
      border: 1px solid #1f2937;
      border-radius: 10px;
      padding: 12px;
    }
    .k { font-size: .8rem; color: #94a3b8; }
    .v { margin-top: 4px; font-size: 1rem; font-weight: 600; }
    .ok { color: #86efac; }
    .hint { font-size: .9rem; color: #93c5fd; }
    code {
      background: #0b1220;
      border: 1px solid #1f2937;
      border-radius: 8px;
      padding: 2px 8px;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Juhl Network Dashboard</h1>
    <p>Bot + API laufen im selben Prozess (Wispbyte kompatibel).</p>

    <section class="grid">
      <div class="item"><div class="k">Bot Status</div><div class="v ok">${escapeHtml(botState)}</div></div>
      <div class="item"><div class="k">Bot Tag</div><div class="v">${escapeHtml(botTag)}</div></div>
      <div class="item"><div class="k">Guilds</div><div class="v">${escapeHtml(String(status.guilds))}</div></div>
      <div class="item"><div class="k">Ping</div><div class="v">${escapeHtml(ping)}</div></div>
      <div class="item"><div class="k">Uptime</div><div class="v">${escapeHtml(String(status.uptimeSec))}s</div></div>
      <div class="item"><div class="k">Server Time</div><div class="v">${escapeHtml(status.now)}</div></div>
    </section>

    <div class="hint">API Endpunkte: <code>/health</code> und <code>/api/status</code></div>
  </main>
</body>
</html>`;
}

const webServer = http.createServer((req, res) => {
  const url = req.url || '/';

  if (url === '/health' || url === '/api/status') {
    const status = getDashboardStatus();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(status, null, 2));
    return;
  }

  if (url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderDashboardHtml());
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'Not Found' }));
});

webServer.listen(PORT, HOST, () => {
  console.log(`Dashboard intern auf http://${HOST}:${PORT}`);
  console.log(`Dashboard extern auf ${PUBLIC_URL}`);
});

function memberMention(userId) {
  return `<@${userId}>`;
}

function checkAutomod(message, cfg) {
  if (!cfg.automod.enabled) return false;
  if (!message.member || hasStaff(message.member, cfg)) return false;

  const content = message.content.toLowerCase();
  let reason = null;

  if (cfg.automod.antiInvite && /(discord\.gg\/|discord\.com\/invite\/)/i.test(content)) {
    reason = 'Discord-Invite';
  }

  if (!reason && cfg.automod.antiLink && /https?:\/\//i.test(content)) {
    reason = 'Link';
  }

  if (!reason && Array.isArray(cfg.automod.badWords)) {
    const found = cfg.automod.badWords.find((w) => w && content.includes(String(w).toLowerCase()));
    if (found) reason = `BadWord (${found})`;
  }

  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  const arr = spamMap.get(key) || [];
  const windowMs = cfg.automod.spamWindowMs || 8000;
  const max = cfg.automod.spamMax || 6;
  arr.push(now);
  const filtered = arr.filter((t) => now - t <= windowMs);
  spamMap.set(key, filtered);
  if (!reason && filtered.length >= max) reason = `Spam (${filtered.length} Nachrichten)`;

  if (reason) {
    return reason;
  }
  return false;
}

async function registerCommands() {
  const appId = CLIENT_ID || client.user?.id;
  if (!appId) {
    console.log('App-ID nicht verfügbar: Slash-Commands konnten nicht registriert werden.');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), { body: commands });
    console.log(`Slash-Commands für Guild ${GUILD_ID} registriert.`);
  } else {
    const guilds = [...client.guilds.cache.values()];
    if (!guilds.length) {
      await rest.put(Routes.applicationCommands(appId), { body: commands });
      console.log('Globale Slash-Commands registriert (kann bis zu 1h dauern).');
      return;
    }

    for (const guild of guilds) {
      await rest.put(Routes.applicationGuildCommands(appId, guild.id), { body: commands });
      console.log(`Slash-Commands für Guild ${guild.id} registriert.`);
    }
  }
}

client.once('ready', async () => {
  loadStore();
  console.log(`Eingeloggt als ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (err) {
    console.error('Fehler bei Slash-Registrierung:', err.message);
  }
});

client.on('guildMemberAdd', async (member) => {
  const cfg = getGuildConfig(member.guild.id);

  if (cfg.autoroleId) {
    try {
      await member.roles.add(cfg.autoroleId, 'AutoRole');
    } catch {}
  }

  if (cfg.welcomeChannelId) {
    const ch = member.guild.channels.cache.get(cfg.welcomeChannelId);
    if (ch && ch.isTextBased()) {
      const embed = new EmbedBuilder().setColor(0x57f287).setTitle('Willkommen!').setDescription(`${memberMention(member.id)} ist dem Server beigetreten.`).setTimestamp();
      ch.send({ embeds: [embed] }).catch(() => {});
    }
  }
});

client.on('guildMemberRemove', async (member) => {
  const cfg = getGuildConfig(member.guild.id);
  if (!cfg.leaveChannelId) return;
  const ch = member.guild.channels.cache.get(cfg.leaveChannelId);
  if (!ch || !ch.isTextBased()) return;
  const embed = new EmbedBuilder().setColor(0xed4245).setTitle('Mitglied verlassen').setDescription(`${member.user.tag} hat den Server verlassen.`).setTimestamp();
  ch.send({ embeds: [embed] }).catch(() => {});
});

client.on('messageDelete', async (message) => {
  if (!message.guild || !message.author || message.author.bot) return;
  const cfg = getGuildConfig(message.guild.id);
  const embed = new EmbedBuilder()
    .setColor(0xffcc4d)
    .setTitle('Nachricht gelöscht')
    .addFields(
      { name: 'User', value: `${message.author.tag} (${message.author.id})` },
      { name: 'Kanal', value: `${message.channel}` },
      { name: 'Inhalt', value: escapeText(message.content || '[kein Text]') }
    )
    .setTimestamp();
  await logToModChannel(message.guild, cfg, embed);
});

client.on('messageUpdate', async (oldMsg, newMsg) => {
  if (!newMsg.guild || !newMsg.author || newMsg.author.bot) return;
  if ((oldMsg.content || '') === (newMsg.content || '')) return;
  const cfg = getGuildConfig(newMsg.guild.id);
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('Nachricht bearbeitet')
    .addFields(
      { name: 'User', value: `${newMsg.author.tag} (${newMsg.author.id})` },
      { name: 'Kanal', value: `${newMsg.channel}` },
      { name: 'Vorher', value: escapeText(oldMsg.content || '[kein Text]') },
      { name: 'Nachher', value: escapeText(newMsg.content || '[kein Text]') }
    )
    .setTimestamp();
  await logToModChannel(newMsg.guild, cfg, embed);
});

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  const cfg = getGuildConfig(message.guild.id);

  const modReason = checkAutomod(message, cfg);
  if (modReason) {
    try {
      await message.delete();
      const warn = await message.channel.send({ content: `${memberMention(message.author.id)}, deine Nachricht wurde durch AutoMod entfernt (${modReason}).` });
      setTimeout(() => warn.delete().catch(() => {}), 6000);

      const embed = new EmbedBuilder()
        .setColor(0xfaa61a)
        .setTitle('AutoMod ausgelöst')
        .addFields(
          { name: 'User', value: `${message.author.tag} (${message.author.id})` },
          { name: 'Grund', value: modReason },
          { name: 'Kanal', value: `${message.channel}` }
        )
        .setTimestamp();
      await logToModChannel(message.guild, cfg, embed);
    } catch {}
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    const [type, guildId, payload] = interaction.customId.split(':');
    if (type === 'ticketopen') {
      const cfg = getGuildConfig(guildId);
      if (!interaction.guild) return;

      const already = interaction.guild.channels.cache.find((c) => c.name === `ticket-${interaction.user.id}`);
      if (already) {
        await interaction.reply({ content: `Du hast bereits ein Ticket: ${already}`, ephemeral: true });
        return;
      }

      const channel = await interaction.guild.channels.create({
        name: `ticket-${interaction.user.id}`,
        type: ChannelType.GuildText,
        parent: cfg.ticketCategoryId || null,
        permissionOverwrites: [
          { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
          ...(cfg.staffRoleId ? [{ id: cfg.staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }] : []),
        ],
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ticketclose:${interaction.guild.id}:${interaction.user.id}`).setLabel('Ticket schließen').setStyle(ButtonStyle.Danger)
      );

      await channel.send({ content: `${memberMention(interaction.user.id)} Ticket erstellt.`, components: [row] });
      await interaction.reply({ content: `Ticket erstellt: ${channel}`, ephemeral: true });
      return;
    }

    if (type === 'ticketclose') {
      if (!interaction.guild || !interaction.channel || interaction.channel.type !== ChannelType.GuildText) return;
      const cfg = getGuildConfig(interaction.guild.id);
      const member = interaction.member;
      if (!hasStaff(member, cfg) && !interaction.channel.name.startsWith(`ticket-${interaction.user.id}`)) {
        await interaction.reply({ content: 'Nur Staff oder Ticket-Ersteller darf schließen.', ephemeral: true });
        return;
      }

      await interaction.reply({ content: 'Ticket wird in 5 Sekunden geschlossen...' });
      setTimeout(async () => {
        try {
          const msgs = await interaction.channel.messages.fetch({ limit: 100 });
          const transcript = [...msgs.values()]
            .reverse()
            .map((m) => `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content}`)
            .join('\n');

          const transcriptPath = path.join(process.cwd(), `transcript-${interaction.channel.id}.txt`);
          fs.writeFileSync(transcriptPath, transcript, 'utf8');

          if (cfg.modLogChannelId) {
            const logChannel = interaction.guild.channels.cache.get(cfg.modLogChannelId);
            if (logChannel && logChannel.isTextBased()) {
              await logChannel.send({ content: `Transcript für ${interaction.channel.name}`, files: [transcriptPath] }).catch(() => {});
            }
          }

          fs.unlinkSync(transcriptPath);
          await interaction.channel.delete('Ticket geschlossen');
        } catch {}
      }, 5000);
      return;
    }
  }

  if (interaction.isStringSelectMenu()) {
    const [kind] = interaction.customId.split(':');
    if (kind === 'rolepanel') {
      if (!interaction.guild || !interaction.member) return;
      const member = interaction.member;
      const selected = interaction.values;
      const allRoleIds = interaction.component.options.map((o) => o.value);

      for (const roleId of allRoleIds) {
        if (selected.includes(roleId)) {
          if (!member.roles.cache.has(roleId)) {
            await member.roles.add(roleId).catch(() => {});
          }
        } else {
          if (member.roles.cache.has(roleId)) {
            await member.roles.remove(roleId).catch(() => {});
          }
        }
      }

      await interaction.reply({ content: 'Rollen aktualisiert.', ephemeral: true });
      return;
    }
  }

  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) {
    await interaction.reply({ content: 'Nur auf Servern nutzbar.', ephemeral: true });
    return;
  }

  const cfg = getGuildConfig(interaction.guild.id);
  const staff = hasStaff(interaction.member, cfg);

  const requireStaff = async () => {
    if (!staff) {
      await interaction.reply({ content: 'Dafür brauchst du Staff-Rechte.', ephemeral: true });
      return false;
    }
    return true;
  };

  try {
    if (interaction.commandName === 'ping') {
      await interaction.reply(`Pong! ${client.ws.ping}ms`);
      return;
    }

    if (interaction.commandName === 'help') {
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('Bot Hilfe')
        .setDescription('Wichtige Bereiche:')
        .addFields(
          { name: 'Strukturiert (empfohlen)', value: '/mod ... und /config ...' },
          { name: 'Moderation', value: '/mod warn|warnings|clearwarnings|kick|ban|unban|timeout|untimeout|purge|slowmode|lock|unlock' },
          { name: 'Setup', value: '/config ... oder alternativ /setup ... /automod ...' },
          { name: 'Info', value: '/ping /serverinfo /userinfo /help' }
        );
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    if (interaction.commandName === 'mod') {
      if (!(await requireStaff())) return;
      const sub = interaction.options.getSubcommand();

      if (sub === 'warn') {
        const user = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason') || 'Kein Grund';
        cfg.warnings[user.id] = cfg.warnings[user.id] || [];
        cfg.warnings[user.id].push({ reason, modId: interaction.user.id, at: Date.now() });
        saveStore();
        await interaction.reply(`${memberMention(user.id)} wurde verwarnt. Grund: ${reason}`);
        return;
      }

      if (sub === 'warnings') {
        const user = interaction.options.getUser('user', true);
        const list = cfg.warnings[user.id] || [];
        if (!list.length) {
          await interaction.reply({ content: 'Keine Warnungen.', ephemeral: true });
          return;
        }
        const lines = list.slice(-15).map((w, i) => `${i + 1}. ${w.reason} - <@${w.modId}> - <t:${Math.floor(w.at / 1000)}:R>`);
        await interaction.reply({ content: `Warnungen für ${user.tag}:\n${lines.join('\n')}`, ephemeral: true });
        return;
      }

      if (sub === 'clearwarnings') {
        const user = interaction.options.getUser('user', true);
        delete cfg.warnings[user.id];
        saveStore();
        await interaction.reply({ content: `Warnungen für ${user.tag} wurden gelöscht.`, ephemeral: true });
        return;
      }

      if (sub === 'kick') {
        const user = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason') || 'Kein Grund';
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) return interaction.reply({ content: 'Mitglied nicht gefunden.', ephemeral: true });
        await member.kick(reason);
        await interaction.reply(`✅ ${user.tag} wurde gekickt.`);
        return;
      }

      if (sub === 'ban') {
        const user = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason') || 'Kein Grund';
        const deleteDays = interaction.options.getInteger('delete_days') || 0;
        await interaction.guild.members.ban(user.id, { reason, deleteMessageSeconds: deleteDays * 86400 });
        await interaction.reply(`✅ ${user.tag} wurde gebannt.`);
        return;
      }

      if (sub === 'unban') {
        const userId = interaction.options.getString('userid', true);
        const reason = interaction.options.getString('reason') || 'Kein Grund';
        await interaction.guild.members.unban(userId, reason);
        await interaction.reply(`✅ User ${userId} wurde entbannt.`);
        return;
      }

      if (sub === 'timeout') {
        const user = interaction.options.getUser('user', true);
        const durationInput = interaction.options.getString('dauer', true);
        const reason = interaction.options.getString('reason') || 'Kein Grund';
        const duration = parseDuration(durationInput);
        if (!duration || duration < 1000 || duration > 2419200000) {
          await interaction.reply({ content: 'Ungültige Dauer. Erlaubt: z.B. 10m, 2h, 1d (max 28d).', ephemeral: true });
          return;
        }
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) return interaction.reply({ content: 'Mitglied nicht gefunden.', ephemeral: true });
        await member.timeout(duration, reason);
        await interaction.reply(`✅ ${user.tag} wurde für ${durationInput} getimeoutet.`);
        return;
      }

      if (sub === 'untimeout') {
        const user = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason') || 'Kein Grund';
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) return interaction.reply({ content: 'Mitglied nicht gefunden.', ephemeral: true });
        await member.timeout(null, reason);
        await interaction.reply(`✅ Timeout von ${user.tag} entfernt.`);
        return;
      }

      if (sub === 'purge') {
        const amount = interaction.options.getInteger('amount', true);
        const deleted = await interaction.channel.bulkDelete(amount, true);
        await interaction.reply({ content: `🧹 ${deleted.size} Nachrichten gelöscht.`, ephemeral: true });
        return;
      }

      if (sub === 'slowmode') {
        const sec = interaction.options.getInteger('seconds', true);
        await interaction.channel.setRateLimitPerUser(sec, `Von ${interaction.user.tag} gesetzt`);
        await interaction.reply({ content: `⏱️ Slowmode auf ${sec}s gesetzt.` });
        return;
      }

      if (sub === 'lock') {
        await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false });
        await interaction.reply('🔒 Kanal gesperrt.');
        return;
      }

      if (sub === 'unlock') {
        await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: null });
        await interaction.reply('🔓 Kanal entsperrt.');
        return;
      }
    }

    if (interaction.commandName === 'config') {
      if (!(await requireStaff())) return;
      const sub = interaction.options.getSubcommand();

      if (sub === 'log') cfg.modLogChannelId = interaction.options.getChannel('channel').id;
      if (sub === 'welcome') cfg.welcomeChannelId = interaction.options.getChannel('channel').id;
      if (sub === 'leave') cfg.leaveChannelId = interaction.options.getChannel('channel').id;
      if (sub === 'suggestions') cfg.suggestionChannelId = interaction.options.getChannel('channel').id;
      if (sub === 'ticket-category') cfg.ticketCategoryId = interaction.options.getChannel('category').id;
      if (sub === 'staffrole') cfg.staffRoleId = interaction.options.getRole('role').id;
      if (sub === 'autorole') cfg.autoroleId = interaction.options.getRole('role').id;
      if (sub === 'automod-toggle') cfg.automod.enabled = interaction.options.getBoolean('enabled', true);
      if (sub === 'automod-antilink') cfg.automod.antiLink = interaction.options.getBoolean('enabled', true);
      if (sub === 'automod-antiinvite') cfg.automod.antiInvite = interaction.options.getBoolean('enabled', true);
      if (sub === 'automod-addbadword') {
        const w = interaction.options.getString('word', true).toLowerCase();
        if (!cfg.automod.badWords.includes(w)) cfg.automod.badWords.push(w);
      }
      if (sub === 'automod-removebadword') {
        const w = interaction.options.getString('word', true).toLowerCase();
        cfg.automod.badWords = cfg.automod.badWords.filter((x) => x !== w);
      }

      saveStore();
      await interaction.reply({ content: `Config gespeichert: ${sub}`, ephemeral: true });
      return;
    }

    if (interaction.commandName === 'serverinfo') {
      const g = interaction.guild;
      const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setTitle(`Serverinfo: ${g.name}`)
        .addFields(
          { name: 'ID', value: g.id, inline: true },
          { name: 'Mitglieder', value: String(g.memberCount), inline: true },
          { name: 'Owner', value: `<@${g.ownerId}>`, inline: true },
          { name: 'Erstellt', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:F>` }
        )
        .setThumbnail(g.iconURL());
      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (interaction.commandName === 'userinfo') {
      const user = interaction.options.getUser('user') || interaction.user;
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      const embed = new EmbedBuilder()
        .setColor(0x7289da)
        .setTitle(`Userinfo: ${user.tag}`)
        .setThumbnail(user.displayAvatarURL())
        .addFields(
          { name: 'ID', value: user.id, inline: true },
          { name: 'Bot', value: user.bot ? 'Ja' : 'Nein', inline: true },
          { name: 'Account erstellt', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:F>`, inline: false },
          { name: 'Server beigetreten', value: member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>` : 'Unbekannt', inline: false }
        );
      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (interaction.commandName === 'setup') {
      if (!(await requireStaff())) return;
      const sub = interaction.options.getSubcommand();

      if (sub === 'log') cfg.modLogChannelId = interaction.options.getChannel('channel').id;
      if (sub === 'welcome') cfg.welcomeChannelId = interaction.options.getChannel('channel').id;
      if (sub === 'leave') cfg.leaveChannelId = interaction.options.getChannel('channel').id;
      if (sub === 'suggestions') cfg.suggestionChannelId = interaction.options.getChannel('channel').id;
      if (sub === 'ticket-category') cfg.ticketCategoryId = interaction.options.getChannel('category').id;
      if (sub === 'staffrole') cfg.staffRoleId = interaction.options.getRole('role').id;
      if (sub === 'autorole') cfg.autoroleId = interaction.options.getRole('role').id;

      saveStore();
      await interaction.reply({ content: `Setup gespeichert: ${sub}`, ephemeral: true });
      return;
    }

    if (interaction.commandName === 'automod') {
      if (!(await requireStaff())) return;
      const sub = interaction.options.getSubcommand();
      if (sub === 'toggle') cfg.automod.enabled = interaction.options.getBoolean('enabled', true);
      if (sub === 'antilink') cfg.automod.antiLink = interaction.options.getBoolean('enabled', true);
      if (sub === 'antiinvite') cfg.automod.antiInvite = interaction.options.getBoolean('enabled', true);
      if (sub === 'addbadword') {
        const w = interaction.options.getString('word', true).toLowerCase();
        if (!cfg.automod.badWords.includes(w)) cfg.automod.badWords.push(w);
      }
      if (sub === 'removebadword') {
        const w = interaction.options.getString('word', true).toLowerCase();
        cfg.automod.badWords = cfg.automod.badWords.filter((x) => x !== w);
      }
      saveStore();
      await interaction.reply({ content: `AutoMod aktualisiert: ${sub}`, ephemeral: true });
      return;
    }

    if (interaction.commandName === 'warn') {
      if (!(await requireStaff())) return;
      const user = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason') || 'Kein Grund';
      cfg.warnings[user.id] = cfg.warnings[user.id] || [];
      cfg.warnings[user.id].push({ reason, modId: interaction.user.id, at: Date.now() });
      saveStore();
      await interaction.reply(`${memberMention(user.id)} wurde verwarnt. Grund: ${reason}`);
      return;
    }

    if (interaction.commandName === 'warnings') {
      if (!(await requireStaff())) return;
      const user = interaction.options.getUser('user', true);
      const list = cfg.warnings[user.id] || [];
      if (!list.length) {
        await interaction.reply({ content: 'Keine Warnungen.', ephemeral: true });
        return;
      }
      const lines = list.slice(-15).map((w, i) => `${i + 1}. ${w.reason} - <@${w.modId}> - <t:${Math.floor(w.at / 1000)}:R>`);
      await interaction.reply({ content: `Warnungen für ${user.tag}:\n${lines.join('\n')}`, ephemeral: true });
      return;
    }

    if (interaction.commandName === 'clearwarnings') {
      if (!(await requireStaff())) return;
      const user = interaction.options.getUser('user', true);
      delete cfg.warnings[user.id];
      saveStore();
      await interaction.reply({ content: `Warnungen für ${user.tag} wurden gelöscht.`, ephemeral: true });
      return;
    }

    if (interaction.commandName === 'kick') {
      if (!(await requireStaff())) return;
      const user = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason') || 'Kein Grund';
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return interaction.reply({ content: 'Mitglied nicht gefunden.', ephemeral: true });
      await member.kick(reason);
      await interaction.reply(`✅ ${user.tag} wurde gekickt.`);
      return;
    }

    if (interaction.commandName === 'ban') {
      if (!(await requireStaff())) return;
      const user = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason') || 'Kein Grund';
      const deleteDays = interaction.options.getInteger('delete_days') || 0;
      await interaction.guild.members.ban(user.id, { reason, deleteMessageSeconds: deleteDays * 86400 });
      await interaction.reply(`✅ ${user.tag} wurde gebannt.`);
      return;
    }

    if (interaction.commandName === 'unban') {
      if (!(await requireStaff())) return;
      const userId = interaction.options.getString('userid', true);
      const reason = interaction.options.getString('reason') || 'Kein Grund';
      await interaction.guild.members.unban(userId, reason);
      await interaction.reply(`✅ User ${userId} wurde entbannt.`);
      return;
    }

    if (interaction.commandName === 'timeout') {
      if (!(await requireStaff())) return;
      const user = interaction.options.getUser('user', true);
      const durationInput = interaction.options.getString('dauer', true);
      const reason = interaction.options.getString('reason') || 'Kein Grund';
      const duration = parseDuration(durationInput);
      if (!duration || duration < 1000 || duration > 2419200000) {
        await interaction.reply({ content: 'Ungültige Dauer. Erlaubt: z.B. 10m, 2h, 1d (max 28d).', ephemeral: true });
        return;
      }
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return interaction.reply({ content: 'Mitglied nicht gefunden.', ephemeral: true });
      await member.timeout(duration, reason);
      await interaction.reply(`✅ ${user.tag} wurde für ${durationInput} getimeoutet.`);
      return;
    }

    if (interaction.commandName === 'untimeout') {
      if (!(await requireStaff())) return;
      const user = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason') || 'Kein Grund';
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return interaction.reply({ content: 'Mitglied nicht gefunden.', ephemeral: true });
      await member.timeout(null, reason);
      await interaction.reply(`✅ Timeout von ${user.tag} entfernt.`);
      return;
    }

    if (interaction.commandName === 'purge') {
      if (!(await requireStaff())) return;
      const amount = interaction.options.getInteger('amount', true);
      const deleted = await interaction.channel.bulkDelete(amount, true);
      await interaction.reply({ content: `🧹 ${deleted.size} Nachrichten gelöscht.`, ephemeral: true });
      return;
    }

    if (interaction.commandName === 'slowmode') {
      if (!(await requireStaff())) return;
      const sec = interaction.options.getInteger('seconds', true);
      await interaction.channel.setRateLimitPerUser(sec, `Von ${interaction.user.tag} gesetzt`);
      await interaction.reply({ content: `⏱️ Slowmode auf ${sec}s gesetzt.` });
      return;
    }

    if (interaction.commandName === 'lock') {
      if (!(await requireStaff())) return;
      await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false });
      await interaction.reply('🔒 Kanal gesperrt.');
      return;
    }

    if (interaction.commandName === 'unlock') {
      if (!(await requireStaff())) return;
      await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: null });
      await interaction.reply('🔓 Kanal entsperrt.');
      return;
    }

    if (interaction.commandName === 'announce') {
      if (!(await requireStaff())) return;
      const title = interaction.options.getString('title', true);
      const text = interaction.options.getString('text', true);
      const target = interaction.options.getChannel('channel') || interaction.channel;
      if (!target.isTextBased()) {
        await interaction.reply({ content: 'Zielkanal ist nicht textbasiert.', ephemeral: true });
        return;
      }
      const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(title).setDescription(text).setTimestamp();
      await target.send({ embeds: [embed] });
      await interaction.reply({ content: 'Ankündigung gesendet.', ephemeral: true });
      return;
    }

    if (interaction.commandName === 'suggest') {
      const text = interaction.options.getString('text', true);
      const chId = cfg.suggestionChannelId;
      const target = chId ? interaction.guild.channels.cache.get(chId) : interaction.channel;
      if (!target || !target.isTextBased()) {
        await interaction.reply({ content: 'Suggestion-Channel ungültig. Nutze /setup suggestions.', ephemeral: true });
        return;
      }
      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle('Neue Suggestion')
        .setDescription(text)
        .addFields({ name: 'Von', value: `${interaction.user.tag} (${interaction.user.id})` })
        .setTimestamp();
      const msg = await target.send({ embeds: [embed] });
      await msg.react('✅').catch(() => {});
      await msg.react('❌').catch(() => {});
      await interaction.reply({ content: 'Suggestion gepostet.', ephemeral: true });
      return;
    }

    if (interaction.commandName === 'ticketpanel') {
      if (!(await requireStaff())) return;
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ticketopen:${interaction.guild.id}:open`).setLabel('Ticket erstellen').setStyle(ButtonStyle.Primary)
      );
      const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Support Tickets').setDescription('Klicke auf den Button, um ein Ticket zu erstellen.');
      await interaction.channel.send({ embeds: [embed], components: [row] });
      await interaction.reply({ content: 'Ticket-Panel gepostet.', ephemeral: true });
      return;
    }

    if (interaction.commandName === 'ticketclose') {
      if (!(await requireStaff())) return;
      if (!interaction.channel.name.startsWith('ticket-')) {
        await interaction.reply({ content: 'Das ist kein Ticket-Kanal.', ephemeral: true });
        return;
      }
      await interaction.reply('Ticket wird in 5 Sekunden geschlossen...');
      setTimeout(() => interaction.channel.delete('Ticket geschlossen via Slash').catch(() => {}), 5000);
      return;
    }

    if (interaction.commandName === 'rolepanel') {
      if (!(await requireStaff())) return;
      const roles = ['role1', 'role2', 'role3', 'role4', 'role5']
        .map((k) => interaction.options.getRole(k))
        .filter(Boolean);

      const unique = [...new Map(roles.map((r) => [r.id, r])).values()];
      if (!unique.length) {
        await interaction.reply({ content: 'Mindestens eine Rolle nötig.', ephemeral: true });
        return;
      }

      const menu = new StringSelectMenuBuilder()
        .setCustomId(`rolepanel:${interaction.guild.id}:${Date.now()}`)
        .setPlaceholder('Wähle deine Rollen')
        .setMinValues(0)
        .setMaxValues(unique.length)
        .addOptions(unique.map((role) => ({ label: role.name.slice(0, 100), value: role.id })));

      const row = new ActionRowBuilder().addComponents(menu);
      await interaction.channel.send({ content: 'Rollen auswählen:', components: [row] });
      await interaction.reply({ content: 'Role-Panel gepostet.', ephemeral: true });
      return;
    }

    await interaction.reply({ content: 'Unbekannter Command.', ephemeral: true });
  } catch (err) {
    console.error(err);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: `Fehler: ${err.message}`, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: `Fehler: ${err.message}`, ephemeral: true }).catch(() => {});
    }
  }
});

client.on('guildAuditLogEntryCreate', async (entry, guild) => {
  const cfg = getGuildConfig(guild.id);
  if (!cfg.modLogChannelId) return;

  const interesting = [AuditLogEvent.MemberKick, AuditLogEvent.MemberBanAdd, AuditLogEvent.MemberBanRemove];
  if (!interesting.includes(entry.action)) return;

  const titleMap = {
    [AuditLogEvent.MemberKick]: 'Kick',
    [AuditLogEvent.MemberBanAdd]: 'Ban',
    [AuditLogEvent.MemberBanRemove]: 'Unban',
  };

  const embed = new EmbedBuilder()
    .setColor(0xeb459e)
    .setTitle(`Audit Log: ${titleMap[entry.action] || entry.action}`)
    .addFields(
      { name: 'Target', value: `${entry.target?.tag || entry.targetId || 'Unbekannt'}` },
      { name: 'Executor', value: `${entry.executor?.tag || 'Unbekannt'}` },
      { name: 'Grund', value: entry.reason || 'Kein Grund' }
    )
    .setTimestamp();

  await logToModChannel(guild, cfg, embed);
});

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err));

client.login(TOKEN);
