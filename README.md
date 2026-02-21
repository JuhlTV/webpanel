# Juhl Network Discord Bot

Full-featured Discord Bot mit Web Dashboard.

## Features
- Moderation (warn, kick, ban, timeout, purge)
- AutoMod (Anti-Invite, Anti-Link, BadWords, Spam)
- Ticket System mit Transcripts
- Role Panels
- Welcome/Leave Messages
- Audit Logging
- Web Dashboard

## Deployment auf Railway

1. GitHub Repository erstellen und Code pushen
2. Railway.app Account erstellen
3. "New Project" → "Deploy from GitHub repo"
4. Environment Variables setzen:
   - `DISCORD_TOKEN` = Dein Bot Token
   - `PUBLIC_URL` = https://juhl-network.uk (oder Railway URL)
5. Custom Domain in Railway Settings hinzufügen

## Lokale Installation

```bash
npm install
node index.js
```

## Umgebungsvariablen

- `DISCORD_TOKEN` - Discord Bot Token (erforderlich)
- `CLIENT_ID` - Discord Application ID (optional)
- `GUILD_ID` - Test Server ID für schnellere Command-Registrierung (optional)
- `PORT` - HTTP Port (default: 3000)
- `PUBLIC_URL` - Öffentliche URL für Dashboard (default: localhost)
