/*
  Discord Bot mit vollständigem Management Dashboard
  Features: Discord OAuth2 Login, Server-Verwaltung, Config-Management
  
  Environment Variables:
    DISCORD_TOKEN - Bot Token (required)
    CLIENT_ID - Discord Application ID (required for OAuth)
    CLIENT_SECRET - Discord Application Secret (required for OAuth)
    PORT - HTTP Port (default: 3000)
    PUBLIC_URL - Public URL for callbacks (required for OAuth)
    SESSION_SECRET - Cookie secret (auto-generated if not set)
*/

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const querystring = require('node:querystring');

let djs, express, cookieSession;
try {
  djs = require('discord.js');
  express = require('express');
  cookieSession = require('cookie-session');
} catch (err) {
  console.error('Dependencies fehlen. Bitte installieren: npm install');
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

// Environment configuration
const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const GUILD_ID = process.env.GUILD_ID;
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex');

const OAUTH_REDIRECT_URI = `${PUBLIC_URL}/auth/callback`;
const OAUTH_SCOPES = ['identify', 'guilds'];

if (!TOKEN) {
  console.error('❌ DISCORD_TOKEN fehlt!');
  process.exit(1);
}

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn('⚠️  CLIENT_ID oder CLIENT_SECRET fehlt - Dashboard Login deaktiviert');
}

const DATA_FILE = path.join(process.cwd(), 'bot-data.json');

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
    badWords: [],
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
    console.error('Konnte bot-data.json nicht lesen:', err.message);
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

function memberMention(userId) {
  return `<@${userId}>`;
}

// HTTP helper for Discord API
function discordAPIRequest(endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    const url = `https://discord.com/api/v10${endpoint}`;
    const req = https.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

// OAuth2 token exchange
async function exchangeCode(code) {
  const data = querystring.stringify({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: OAUTH_REDIRECT_URI,
  });

  return new Promise((resolve, reject) => {
    const req = https.request('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': data.length,
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Slash commands definition
const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Zeigt die Bot-Latenz.'),
  new SlashCommandBuilder()
    .setName('dashboard')
    .setDescription('Zeigt den Link zum Bot Dashboard (nur für Admins)')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder()
    .setName('mod')
    .setDescription('Moderationsbefehle')
    .addSubcommand(s => s.setName('warn').setDescription('Warnt ein Mitglied').addUserOption(o => o.setName('user').setDescription('Ziel').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Grund')))
    .addSubcommand(s => s.setName('kick').setDescription('Kickt ein Mitglied').addUserOption(o => o.setName('user').setDescription('Ziel').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Grund')))
    .addSubcommand(s => s.setName('ban').setDescription('Bannt ein Mitglied').addUserOption(o => o.setName('user').setDescription('Ziel').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Grund')))
    .addSubcommand(s => s.setName('purge').setDescription('Löscht Nachrichten').addIntegerOption(o => o.setName('amount').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100))),
].map(c => c.toJSON());

// Initialize Discord Client
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

// Register slash commands
async function registerCommands() {
  const appId = CLIENT_ID || client.user?.id;
  if (!appId) return;

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const guilds = [...client.guilds.cache.values()];
  
  for (const guild of guilds) {
    await rest.put(Routes.applicationGuildCommands(appId, guild.id), { body: commands });
    console.log(`✅ Commands registriert für ${guild.name}`);
  }
}

client.once('ready', async () => {
  loadStore();
  console.log(`✅ Bot eingeloggt als ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (err) {
    console.error('Fehler bei Command-Registrierung:', err.message);
  }
});

// Bot event handlers (simplified - add your full handlers here)
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return;

  const cfg = getGuildConfig(interaction.guild.id);
  const staff = hasStaff(interaction.member, cfg);

  try {
    if (interaction.commandName === 'ping') {
      await interaction.reply(`🏓 Pong! ${client.ws.ping}ms`);
    }

    if (interaction.commandName === 'dashboard') {
      // Check for Administrator permission
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return await interaction.reply({
          content: '❌ Du brauchst Administrator-Rechte um diesen Command zu nutzen!',
          ephemeral: true
        });
      }

      const embed = new EmbedBuilder()
        .setColor(0x667eea)
        .setTitle('🎮 Bot Dashboard')
        .setDescription('Verwalte den Bot über das Web Dashboard!')
        .addFields(
          { name: '🔗 Dashboard Link', value: `[Hier klicken](${PUBLIC_URL})` },
          { name: '📊 Features', value: '• Channel Konfiguration\n• Rollen Management\n• AutoMod Settings\n• Live Bot Stats' }
        )
        .setFooter({ text: 'Nur für Admins sichtbar' })
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // Add more command handlers here...
  } catch (err) {
    console.error(err);
    await interaction.reply({ content: `Fehler: ${err.message}`, ephemeral: true }).catch(() => {});
  }
});

// Express Web Server
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieSession({
  name: 'session',
  keys: [SESSION_SECRET],
  maxAge: 24 * 60 * 60 * 1000, // 24 hours
}));

// Middleware: Check if user is authenticated
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/');
  }
  next();
}

// Middleware: Check if user has manage permissions for guild
function canManageGuild(req, guildId) {
  const userGuild = req.session.guilds?.find(g => g.id === guildId);
  if (!userGuild) return false;
  const permissions = BigInt(userGuild.permissions);
  return (permissions & BigInt(0x20)) === BigInt(0x20); // MANAGE_GUILD
}

const DASHBOARD_FILE = path.join(process.cwd(), 'dashboard.html');

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
  const botStateClass = status.botReady ? 'status-online' : 'status-starting';
  const ping = status.pingMs == null ? '-' : `${status.pingMs} ms`;
  const botTag = status.botTag || 'Nicht verbunden';

  try {
    const template = fs.readFileSync(DASHBOARD_FILE, 'utf8');
    return template
      .replace(/\{\{BOT_STATE\}\}/g, escapeHtml(botState))
      .replace(/\{\{BOT_STATE_CLASS\}\}/g, botStateClass)
      .replace(/\{\{BOT_TAG\}\}/g, escapeHtml(botTag))
      .replace(/\{\{GUILDS\}\}/g, escapeHtml(String(status.guilds)))
      .replace(/\{\{PING\}\}/g, escapeHtml(ping))
      .replace(/\{\{UPTIME\}\}/g, escapeHtml(String(status.uptimeSec)))
      .replace(/\{\{NOW\}\}/g, escapeHtml(status.now));
  } catch (err) {
    return `<!DOCTYPE html>
<html><head><title>Dashboard Error</title></head>
<body style="font-family: sans-serif; text-align: center; padding: 50px;">
<h1>⚠️ Dashboard nicht gefunden</h1>
<p>dashboard.html fehlt!</p>
<p>Bot Status: ${status.botReady ? '✅ Online' : '❌ Offline'}</p>
</body></html>`;
  }
}

// Home page - Render Dashboard
app.get('/', (req, res) => {
  res.send(renderDashboardHtml());
});

// OAuth callback
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/');

  try {
    const tokenData = await exchangeCode(code);
    const userDataRaw = await discordAPIRequest('/users/@me', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
    });
    const guildsData = await discordAPIRequest('/users/@me/guilds', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
    });

    req.session.user = {
      id: userDataRaw.id,
      username: userDataRaw.username,
      discriminator: userDataRaw.discriminator,
      avatar: userDataRaw.avatar,
    };
    req.session.guilds = guildsData.filter(g => {
      const permissions = BigInt(g.permissions);
      return (permissions & BigInt(0x20)) === BigInt(0x20); // MANAGE_GUILD
    });

    res.redirect('/dashboard');
  } catch (err) {
    console.error('OAuth Error:', err);
    res.send('Login fehlgeschlagen. <a href="/">Zurück</a>');
  }
});

// Logout
app.get('/auth/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

// Dashboard - Server selection
app.get('/dashboard', requireAuth, (req, res) => {
  const botGuilds = client.guilds.cache;
  const userManageableGuilds = req.session.guilds.filter(ug => botGuilds.has(ug.id));

  const guildsHTML = userManageableGuilds.map(g => {
    const icon = g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : 'https://cdn.discordapp.com/embed/avatars/0.png';
    return `
      <a href="/dashboard/${g.id}" class="guild-card">
        <img src="${icon}" alt="${g.name}">
        <span>${g.name}</span>
      </a>
    `;
  }).join('');

  res.send(`
    <!DOCTYPE html>
    <html lang="de">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Dashboard - Server wählen</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'Segoe UI', sans-serif;
          background: #0b1220;
          color: #e5e7eb;
          padding: 20px;
        }
        .header {
          max-width: 1200px;
          margin: 0 auto 40px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .header h1 { font-size: 2rem; }
        .logout-btn {
          padding: 10px 20px;
          background: #ef4444;
          color: white;
          text-decoration: none;
          border-radius: 8px;
        }
        .container {
          max-width: 1200px;
          margin: 0 auto;
        }
        .guild-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
          gap: 20px;
        }
        .guild-card {
          display: flex;
          align-items: center;
          gap: 15px;
          padding: 20px;
          background: #111827;
          border: 2px solid #1f2937;
          border-radius: 12px;
          text-decoration: none;
          color: #e5e7eb;
          transition: all 0.2s;
        }
        .guild-card:hover {
          border-color: #667eea;
          transform: translateY(-2px);
        }
        .guild-card img {
          width: 50px;
          height: 50px;
          border-radius: 50%;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>🎮 Server wählen</h1>
        <a href="/auth/logout" class="logout-btn">Logout</a>
      </div>
      <div class="container">
        <div class="guild-grid">
          ${guildsHTML || '<p>Keine Server gefunden.</p>'}
        </div>
      </div>
    </body>
    </html>
  `);
});

// Dashboard - Guild management
app.get('/dashboard/:guildId', requireAuth, (req, res) => {
  const guildId = req.params.guildId;
  
  if (!canManageGuild(req, guildId)) {
    return res.send('Keine Berechtigung für diesen Server. <a href="/dashboard">Zurück</a>');
  }

  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    return res.send('Bot ist nicht auf diesem Server. <a href="/dashboard">Zurück</a>');
  }

  const cfg = getGuildConfig(guildId);
  const channels = guild.channels.cache.filter(c => c.isTextBased()).map(c => ({ id: c.id, name: c.name }));
  const roles = guild.roles.cache.map(r => ({ id: r.id, name: r.name }));

  res.send(`
    <!DOCTYPE html>
    <html lang="de">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Dashboard - ${guild.name}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'Segoe UI', sans-serif;
          background: #0b1220;
          color: #e5e7eb;
          padding: 20px;
        }
        .header {
          max-width: 900px;
          margin: 0 auto 40px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .header h1 { font-size: 2rem; }
        .back-btn {
          padding: 10px 20px;
          background: #3b82f6;
          color: white;
          text-decoration: none;
          border-radius: 8px;
        }
        .container {
          max-width: 900px;
          margin: 0 auto;
        }
        .card {
          background: #111827;
          border: 1px solid #1f2937;
          border-radius: 12px;
          padding: 30px;
          margin-bottom: 20px;
        }
        .card h2 {
          margin-bottom: 20px;
          color: #667eea;
        }
        .form-group {
          margin-bottom: 20px;
        }
        .form-group label {
          display: block;
          margin-bottom: 8px;
          color: #9ca3af;
        }
        .form-group select, .form-group input {
          width: 100%;
          padding: 10px;
          background: #0b1220;
          border: 1px solid #1f2937;
          border-radius: 8px;
          color: #e5e7eb;
        }
        .btn {
          padding: 12px 30px;
          background: #667eea;
          color: white;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-size: 1rem;
        }
        .btn:hover { background: #5568d3; }
        .success { color: #86efac; margin-top: 10px; }
        .error { color: #fca5a5; margin-top: 10px; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>⚙️ ${guild.name}</h1>
        <a href="/dashboard" class="back-btn">← Zurück</a>
      </div>
      <div class="container">
        
        <div class="card">
          <h2>📢 Channels</h2>
          <form id="channelsForm">
            <input type="hidden" name="guildId" value="${guildId}">
            
            <div class="form-group">
              <label>Welcome Channel:</label>
              <select name="welcomeChannelId">
                <option value="">Deaktiviert</option>
                ${channels.map(c => `<option value="${c.id}" ${cfg.welcomeChannelId === c.id ? 'selected' : ''}>#${c.name}</option>`).join('')}
              </select>
            </div>

            <div class="form-group">
              <label>Leave Channel:</label>
              <select name="leaveChannelId">
                <option value="">Deaktiviert</option>
                ${channels.map(c => `<option value="${c.id}" ${cfg.leaveChannelId === c.id ? 'selected' : ''}>#${c.name}</option>`).join('')}
              </select>
            </div>

            <div class="form-group">
              <label>Mod Log Channel:</label>
              <select name="modLogChannelId">
                <option value="">Deaktiviert</option>
                ${channels.map(c => `<option value="${c.id}" ${cfg.modLogChannelId === c.id ? 'selected' : ''}>#${c.name}</option>`).join('')}
              </select>
            </div>

            <button type="submit" class="btn">Channels speichern</button>
            <div id="channelsMessage"></div>
          </form>
        </div>

        <div class="card">
          <h2>👥 Rollen</h2>
          <form id="rolesForm">
            <input type="hidden" name="guildId" value="${guildId}">
            
            <div class="form-group">
              <label>Staff Rolle:</label>
              <select name="staffRoleId">
                <option value="">Keine</option>
                ${roles.map(r => `<option value="${r.id}" ${cfg.staffRoleId === r.id ? 'selected' : ''}>@${r.name}</option>`).join('')}
              </select>
            </div>

            <div class="form-group">
              <label>Auto-Rolle (bei Join):</label>
              <select name="autoroleId">
                <option value="">Keine</option>
                ${roles.map(r => `<option value="${r.id}" ${cfg.autoroleId === r.id ? 'selected' : ''}>@${r.name}</option>`).join('')}
              </select>
            </div>

            <button type="submit" class="btn">Rollen speichern</button>
            <div id="rolesMessage"></div>
          </form>
        </div>

        <div class="card">
          <h2>🛡️ AutoMod</h2>
          <form id="automodForm">
            <input type="hidden" name="guildId" value="${guildId}">
            
            <div class="form-group">
              <label>
                <input type="checkbox" name="enabled" ${cfg.automod.enabled ? 'checked' : ''}>
                AutoMod aktiviert
              </label>
            </div>

            <div class="form-group">
              <label>
                <input type="checkbox" name="antiInvite" ${cfg.automod.antiInvite ? 'checked' : ''}>
                Anti-Invite (Discord Einladungen blockieren)
              </label>
            </div>

            <div class="form-group">
              <label>
                <input type="checkbox" name="antiLink" ${cfg.automod.antiLink ? 'checked' : ''}>
                Anti-Link (Alle Links blockieren)
              </label>
            </div>

            <button type="submit" class="btn">AutoMod speichern</button>
            <div id="automodMessage"></div>
          </form>
        </div>
      </div>

      <script>
        async function handleSubmit(formId, endpoint, messageId) {
          document.getElementById(formId).addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            const data = Object.fromEntries(formData);
            
            // Convert checkboxes
            if (formId === 'automodForm') {
              data.enabled = formData.has('enabled');
              data.antiInvite = formData.has('antiInvite');
              data.antiLink = formData.has('antiLink');
            }
            
            const res = await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(data),
            });
            
            const result = await res.json();
            const msg = document.getElementById(messageId);
            
            if (result.success) {
              msg.innerHTML = '<p class="success">✅ Gespeichert!</p>';
            } else {
              msg.innerHTML = '<p class="error">❌ Fehler: ' + result.error + '</p>';
            }
            
            setTimeout(() => msg.innerHTML = '', 3000);
          });
        }
        
        handleSubmit('channelsForm', '/api/config/${guildId}/channels', 'channelsMessage');
        handleSubmit('rolesForm', '/api/config/${guildId}/roles', 'rolesMessage');
        handleSubmit('automodForm', '/api/config/${guildId}/automod', 'automodMessage');
      </script>
    </body>
    </html>
  `);
});

// API: Update channels
app.post('/api/config/:guildId/channels', requireAuth, (req, res) => {
  const guildId = req.params.guildId;
  if (!canManageGuild(req, guildId)) {
    return res.json({ success: false, error: 'Keine Berechtigung' });
  }

  const cfg = getGuildConfig(guildId);
  cfg.welcomeChannelId = req.body.welcomeChannelId || null;
  cfg.leaveChannelId = req.body.leaveChannelId || null;
  cfg.modLogChannelId = req.body.modLogChannelId || null;
  saveStore();

  res.json({ success: true });
});

// API: Update roles
app.post('/api/config/:guildId/roles', requireAuth, (req, res) => {
  const guildId = req.params.guildId;
  if (!canManageGuild(req, guildId)) {
    return res.json({ success: false, error: 'Keine Berechtigung' });
  }

  const cfg = getGuildConfig(guildId);
  cfg.staffRoleId = req.body.staffRoleId || null;
  cfg.autoroleId = req.body.autoroleId || null;
  saveStore();

  res.json({ success: true });
});

// API: Update automod
app.post('/api/config/:guildId/automod', requireAuth, (req, res) => {
  const guildId = req.params.guildId;
  if (!canManageGuild(req, guildId)) {
    return res.json({ success: false, error: 'Keine Berechtigung' });
  }

  const cfg = getGuildConfig(guildId);
  cfg.automod.enabled = req.body.enabled === true;
  cfg.automod.antiInvite = req.body.antiInvite === true;
  cfg.automod.antiLink = req.body.antiLink === true;
  saveStore();

  res.json({ success: true });
});

// Simple API endpoints (ohne Auth für Single-Guild Dashboard)
app.get('/api/config', (req, res) => {
  try {
    // Get first guild where bot is
    const guild = client.guilds.cache.first();
    if (!guild) {
      return res.json({ error: 'Bot ist auf keinem Server' });
    }

    const cfg = getGuildConfig(guild.id);
    const channels = guild.channels.cache
      .filter(c => c.isTextBased())
      .map(c => ({ id: c.id, name: c.name }));
    const roles = guild.roles.cache.map(r => ({ id: r.id, name: r.name }));

    res.json({
      success: true,
      config: cfg,
      channels: channels,
      roles: roles,
      guildId: guild.id,
      guildName: guild.name,
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.post('/api/config/channels', express.json(), (req, res) => {
  try {
    const guild = client.guilds.cache.first();
    if (!guild) {
      return res.json({ success: false, error: 'Bot ist auf keinem Server' });
    }

    const cfg = getGuildConfig(guild.id);
    cfg.welcomeChannelId = req.body.welcomeChannelId || null;
    cfg.leaveChannelId = req.body.leaveChannelId || null;
    cfg.modLogChannelId = req.body.modLogChannelId || null;
    cfg.suggestionChannelId = req.body.suggestionChannelId || null;
    saveStore();

    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/config/roles', express.json(), (req, res) => {
  try {
    const guild = client.guilds.cache.first();
    if (!guild) {
      return res.json({ success: false, error: 'Bot ist auf keinem Server' });
    }

    const cfg = getGuildConfig(guild.id);
    cfg.staffRoleId = req.body.staffRoleId || null;
    cfg.autoroleId = req.body.autoroleId || null;
    saveStore();

    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/config/automod', express.json(), (req, res) => {
  try {
    const guild = client.guilds.cache.first();
    if (!guild) {
      return res.json({ success: false, error: 'Bot ist auf keinem Server' });
    }

    const cfg = getGuildConfig(guild.id);
    cfg.automod.enabled = req.body.enabled === true;
    cfg.automod.antiInvite = req.body.antiInvite === true;
    cfg.automod.antiLink = req.body.antiLink === true;
    cfg.automod.spamMax = parseInt(req.body.spamMax) || 6;
    saveStore();

    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    bot: client.isReady() ? 'online' : 'offline',
    guilds: client.guilds.cache.size,
    ping: client.ws.ping,
  });
});

// Start servers
app.listen(PORT, () => {
  console.log(`🌐 Dashboard läuft auf ${PUBLIC_URL}`);
});

client.login(TOKEN);

process.on('uncaughtException', err => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));
