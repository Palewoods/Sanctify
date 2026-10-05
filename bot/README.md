# Sanctify daily Discord post

Every morning a message appears in your Discord channel, posted as **Sanctify**, with:

- the date, liturgical season, and color
- what the Church celebrates (solemnities, feasts, memorials, saints), plus fasting and Sunday notes
- the Verse of the Day (RSV-CE)
- the Saint of the Day, with their icon, patronages, a short life, and a prayer
- today’s Rosary mysteries
- the Prayer of the Day and a quote from the saints
- links to the day’s Mass readings, the Liturgy of the Hours, Mass times, and Sanctify

It reads the website’s own data (`index.html`), so it always matches sanctify.pages.dev/#/today.
It runs on GitHub Actions, so there is nothing to host or keep running.

## Setup (about two minutes)

1. **Make a webhook in Discord.** Open the channel’s settings (the gear next to its name) → **Integrations** →
   **Webhooks** → **New Webhook**. Name it Sanctify if you like (the post sets its own name and picture anyway),
   then **Copy Webhook URL**. Treat this URL like a password: anyone who has it can post in that channel.
2. **Give it to GitHub as a secret.** In the Sanctify repository on GitHub: **Settings** → **Secrets and variables** →
   **Actions** → **New repository secret**. Name it `DISCORD_WEBHOOK_URL` and paste the URL as the value.
3. **Test it.** On GitHub open **Actions** → **Daily Discord post** → **Run workflow**. Tick *Only print the message*
   to preview it in the log, or leave it unticked to post right away.

After that it posts every day at 11:00 UTC (7 AM Eastern in summer, 6 AM in winter).

## Changing it

- **Time:** edit the `cron` line in `.github/workflows/discord-daily.yml` (times are in UTC).
- **Time zone for “today”:** change `TZ: America/New_York` in the same file.
- **What it says:** `bot/core.mjs` builds the message.
- **Preview locally** (needs Node 18+): `node bot/daily.mjs --dry`, or `node bot/daily.mjs --dry 2026-12-25` for another day.
