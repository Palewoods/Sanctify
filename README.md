# Sanctify

**A Catholic repository: prayers, saints, Scripture, hymns, and history, for Roman and Eastern Catholics.**

Visit it at **https://sanctify.pages.dev/**. It is free, has no ads, and works on phones. You can also install it like an app.

The current version is **Sanctify 0.8**.

## What’s inside

- **Today:** the liturgical day and season, the saint of the day, the Verse of the Day, and the day’s prayer.
- **Pray:**
  - Prayers and litanies, the Rosary, the Stations of the Cross, the Divine Mercy and Sacred Heart chaplets, the Angelus, and the Examen.
  - Lectio Divina, an examination of conscience, novenas, a prayer timer, and a prayer tracker.
  - The Little Office of Our Lady, devotions and sacramentals, and Hymns & Chant with recordings.
- **Saints:** more than 800 saints with their lives, feast days, patronages, and icons; a patron saint finder; and quotes of the saints.
- **Library:**
  - The whole Bible (Douay-Rheims) and the Catechism.
  - Classic books to read on the site, and Bible reading plans.
  - Learning resources, and trusted Catholic shops.
- **Learn:**
  - Theology: core beliefs, the Church Fathers, apologetics, and the faith in simple words.
  - The Mass explained, Living the Faith, Catholic Lists, Inside a Church, a glossary, and a quiz.
- **History:** a timeline of Church history, the popes, the ecumenical councils, famous icons, religious orders, and the Eastern Catholic Churches.
- **Calendar:** every feast and season, in the calendar of each edition.
- **Community:** a forum for prayer requests and questions, with accounts, profiles, badges, and moderation, and links to any page of the site inside posts.
- **Community Wiki** and **News**, each with its own page.
- **Settings:** language, edition, theme, text size, and a backup of what you keep on your device.

### Three editions

The edition button in the top bar switches Sanctify between three editions:

- **Roman Catholic**: the Mass and calendar of the Roman Rite as celebrated in most parishes today.
- **Traditional Latin**: the Roman Missal and calendar of 1962. It has the Traditional Latin Mass explained, the feasts of the I, II, and III class, Septuagesima, Passiontide, and the Ember and Rogation Days, and the fifteen mysteries of the Rosary.
- **Eastern Catholic**: the Byzantine calendar and prayers, the Jesus Prayer, the Akathist and Paraklesis, the Divine Liturgy explained, and a guide to a Byzantine church. Each Roman-specific page has an Eastern counterpart.

Sanctify also has many color themes, including dark versions and themes that follow the liturgical season.

### Languages

Sanctify is translated by hand into Spanish, Polish, French, Portuguese, Italian, German, Russian, and Ukrainian: menus, pages, and the common prayers, in the forms Catholics pray them in each language. Longer texts, such as the lives of the saints, are still in English. Other languages are available through Google Translate. The translations live in `lang/`, one file per language, mapping the English text on the page to its translation.

## How it’s built

- `index.html`: the whole site, a single-page app with no build step.
- `data/`: the hymns, the Akathist, and the Little Office, plus the book texts.
- `lang/`: the hand translations, one file per language.
- `bible/`, `books/`, `catechism/`: pages for reading the Bible, books, and Catechism.
- `functions/api/`: a Cloudflare Pages Function that serves the community forum, accounts, and badges, backed by a Cloudflare D1 database.
- `sw.js`: the service worker that lets the site work offline. Bump its `VERSION` when anything in `data/` changes.
- `bot/`: the daily Discord post (see [bot/README.md](bot/README.md)).
- `tools/`: maintenance scripts.

The site deploys automatically to Cloudflare Pages from the `main` branch. To run it locally, serve the folder with any static server:

```bash
python -m http.server 8765
```

Then open http://localhost:8765. The forum needs the Cloudflare Function and database, so it only works when deployed.

## Sources and credits

- Scripture quotations are from the Revised Standard Version of the Bible: Catholic Edition, copyright © 1965, 1966 the Division of Christian Education of the National Council of the Churches of Christ in the United States of America. Used by permission. All rights reserved. The Bible on the site is the public-domain Douay-Rheims, with Bishop Challoner’s notes.
- Images of saints and icons, and hymn recordings, come from Wikipedia and Wikimedia Commons. Each is credited on the site with its license.
- *Ad maiorem Dei gloriam.*
