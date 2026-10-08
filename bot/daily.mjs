// Posts today's Sanctify message to Discord through a channel webhook.
//   node bot/daily.mjs               post today's message (needs DISCORD_WEBHOOK_URL)
//   node bot/daily.mjs --dry         print the message instead of posting it
//   node bot/daily.mjs 2026-12-25    use another date
// "Today" follows the TZ environment variable (the GitHub workflow sets America/New_York).
import { readFile, readdir } from 'node:fs/promises';
import { buildPost } from './core.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const given = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const now = given ? new Date(given + 'T12:00:00') : new Date();
const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
// Saints' lives and prayers live in data/texts/ (see tools/slim_texts.py)
const textsDir = new URL('../data/texts/', import.meta.url);
const texts = {};
for(const f of (await readdir(textsDir)).filter(f => f.endsWith('.json'))) Object.assign(texts, JSON.parse(await readFile(new URL(f, textsDir), 'utf8')));
const post = buildPost(html, day, texts);

if(dry){
  console.log(JSON.stringify(post, null, 2));
  process.exit(0);
}
const hook = process.env.DISCORD_WEBHOOK_URL;
if(!hook){
  console.error('DISCORD_WEBHOOK_URL is not set. Add it as a repository secret (see bot/README.md).');
  process.exit(1);
}
const res = await fetch(hook + (hook.includes('?') ? '&' : '?') + 'wait=true', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(post)
});
if(!res.ok){
  console.error('Discord refused the post:', res.status, await res.text());
  process.exit(1);
}
console.log('Posted the daily message for', day.toDateString());
