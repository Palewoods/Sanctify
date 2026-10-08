// Builds Sanctify's daily Discord post from the website's own code and data (index.html),
// so the server always shows the same saint, verse, and feasts as sanctify.pages.dev/#/today.
// Works in Node (bot/daily.mjs) and in a browser.

const SITE = 'https://sanctify.pages.dev';

// Top-level declarations copied out of index.html, in an order where each only uses earlier ones
const NEEDED = [
  'MONTH_NAMES', 'SEED_DATA', 'CALENDAR_DATA', 'SAINT_PATRONS', 'WEEKDAY_NAMES', 'CAL_TYPE_RANK', 'excerptOf',
  'addDays', 'sameDay', 'easterCache', 'easterDate', 'adventStart', 'baptismOfLord', 'holyFamily', 'fromEaster',
  'MOVEABLE_RULES', 'EXTRA_MOVEABLE', 'moveableCache', 'moveableFor', 'SEASON_INFO', 'liturgicalSeason',
  'SAINT_FEASTS', 'saintCore', 'observancesFor', 'dayNotes', 'DAILY_VERSES', 'dayNumber', 'seededOrder',
  'dailyOrders', 'dailyPick', 'mysterySetFor', 'massReadingsUrl', 'SAINT_ICONS', 'MYSTERIES', 'QUOTES'
];

// The site's code puts every top-level statement at the start of a line and indents everything inside it,
// so a statement runs until the next line that starts at the left edge (closing brackets excepted).
function statementAt(lines, start){
  let end = start + 1;
  while(end < lines.length){
    const line = lines[end];
    if(line === '' || /^[\s})\]]/.test(line)){ end++; continue; }
    break;
  }
  while(end > start + 1 && lines[end - 1] === '') end--;
  return lines.slice(start, end).join('\n');
}

function extract(html){
  const lines = html.split(/\r?\n/);
  const find = re => lines.findIndex(l => re.test(l));
  const parts = ['const isEastern = () => false;'];
  for(const name of NEEDED){
    const i = find(new RegExp(`^(const|let|function) ${name}\\b`));
    if(i < 0) throw new Error('Could not find ' + name + ' in index.html');
    parts.push(statementAt(lines, i));
    if(name === 'SEED_DATA') parts.push('const library = SEED_DATA;');
    if(name === 'SAINT_PATRONS') parts.push("SEED_DATA.forEach(e => { if(SAINT_PATRONS[e.id]) e.patron = SAINT_PATRONS[e.id]; });");
    if(name === 'SAINT_FEASTS'){
      const j = find(/^library\.filter\(e => e\.category === 'saint'\)\.forEach/);
      if(j < 0) throw new Error('Could not find the saint feast index');
      parts.push(statementAt(lines, j));
    }
  }
  const code = parts.join('\n\n') + `
return { liturgicalSeason, observancesFor, dayNotes, dailyPick, DAILY_VERSES, SEED_DATA, mysterySetFor, MYSTERIES,
         massReadingsUrl, SAINT_ICONS, WEEKDAY_NAMES, MONTH_NAMES, excerptOf, QUOTES };`;
  return new Function(code)();
}

const SEASON_COLORS = { violet:0x5b3f86, white:0xc9a227, 'white and red':0x9b1c1f, green:0x3e6b3a, red:0x9b1c1f, rose:0xb04a73 };
const clip = (s, n) => s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;

// texts: the long texts from data/texts/*.json merged into one { id: { content, intercession } } map
export function buildPost(html, d, texts = {}){
  const k = extract(html);
  k.SEED_DATA.forEach(e => { if(texts[e.id]) Object.assign(e, texts[e.id]); });
  const latin = k.SEED_DATA.filter(e => e.rite !== 'eastern');
  const byCat = cat => latin.filter(e => e.category === cat);
  const season = k.liturgicalSeason(d);
  const obs = k.observancesFor(d).filter(o => o.type !== 'Season');
  const notes = k.dayNotes(d, obs);
  const feastIds = obs.flatMap(o => o.saints || []);
  const saint = feastIds.length ? k.SEED_DATA.find(e => e.id === feastIds[0]) : k.dailyPick(byCat('saint'), 11, d);
  const prayer = k.dailyPick(byCat('prayer').filter(p => p.id !== 'p10'), 23, d);
  const verse = k.dailyPick(k.DAILY_VERSES, 37, d);
  const quote = k.dailyPick(k.QUOTES, 97, d);
  const mysteries = k.MYSTERIES[k.mysterySetFor(d)];
  const dateLabel = `${k.WEEKDAY_NAMES[d.getDay()]}, ${k.MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;

  const celebrating = obs.length
    ? obs.slice(0, 6).map(o => `• **${o.name}**${o.type && o.type !== 'Saint' ? ` · ${o.type}` : ''}`).join('\n')
    : `• A weekday in ${season.name}`;
  const saintLines = [
    `**[${saint.title}](${SITE}/#read=${saint.id})**`,
    saint.author ? `*${saint.author}*` : '',
    saint.patron ? `Patron of ${saint.patron}.` : '',
    k.excerptOf(saint.content, 360),
    saint.intercession ? `> ${saint.intercession}` : ''
  ].filter(Boolean);

  const embed = {
    title: dateLabel,
    url: `${SITE}/#/today`,
    color: SEASON_COLORS[season.colorName] ?? 0x7a2426,
    description: `**${season.name}** · liturgical color ${season.colorName}\n\n**The Church celebrates**\n${celebrating}` +
      (notes.length ? `\n\n*${notes.join(' ')}*` : ''),
    fields: [
      { name: '📖 Verse of the Day', value: clip(`“${verse.text}”\n— *${verse.ref}* (RSV-CE)`, 1024) },
      { name: feastIds.length ? '✝️ Saint of the Day · feast today' : '✝️ Saint of the Day', value: clip(saintLines.join('\n'), 1024) },
      { name: '📿 Today’s Rosary', value: clip(`The **${mysteries.name}**: ${mysteries.list.map(m => m.name).join(' · ')}`, 1024) },
      { name: '🙏 Prayer of the Day', value: `[${prayer.title}](${SITE}/#read=${prayer.id})` },
      { name: '💬 From the Saints', value: clip(`“${quote.text}”\n— ${quote.saint}${quote.source ? `, *${quote.source}*` : ''}`, 1024) },
      { name: '🔗 Pray today', value: `[Mass readings](${k.massReadingsUrl(d)}) · [Liturgy of the Hours](https://universalis.com/) · [Find Mass & Confession](https://masstimes.org/) · [Sanctify](${SITE}/#/today)` }
    ],
    footer: { text: 'Sanctify · sanctify.pages.dev' }
  };
  if(k.SAINT_ICONS[saint.id]) embed.thumbnail = { url: k.SAINT_ICONS[saint.id] };
  return { username: 'Sanctify', avatar_url: `${SITE}/icon-512.png`, embeds: [embed], allowed_mentions: { parse: [] } };
}
