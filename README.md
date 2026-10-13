# Sanctify

**A Catholic repository: prayers, saints, Scripture, hymns, and history, for Roman and Eastern Catholics.**

Visit it at **https://sanctify.pages.dev/**. It is free, has no ads, and works on phones. You can also install it like an app.

## What’s inside

- **Today:** the liturgical day and season, the saint of the day, the Verse of the Day, and the day’s prayer.
- **Pray:**
  - Prayers and litanies, the Rosary, the Stations of the Cross, the Divine Mercy and Sacred Heart chaplets, the Angelus, and the Examen.
  - Lectio Divina, an examination of conscience, novenas, a prayer timer, and a prayer tracker.
  - The Little Office of Our Lady, devotions and sacramentals, and Hymns & Chant with recordings.
- **Saints:** hundreds of saints with their lives, feast days, patronages, and icons; a patron saint finder; and quotes of the saints.
- **Library:**
  - The whole Bible (Douay-Rheims) and the Catechism.
  - Classic books to read on the site, and Bible reading plans.
  - Learning resources, and trusted Catholic shops.
- **Learn:**
  - Theology: core beliefs, the Church Fathers, apologetics, and the faith in simple words.
  - The Mass explained, Living the Faith, Catholic Lists, Inside a Church, a glossary, and a quiz.
- **History:** a timeline of Church history, the popes, the ecumenical councils, famous icons, religious orders, and the Eastern Catholic Churches.
- **Community:** a forum for prayer requests and questions, with accounts, badges, and moderation.

### Two editions

A switch in the menu turns Sanctify into an **Eastern Catholic edition**. It has the Byzantine calendar and prayers, the Jesus Prayer, the Akathist and Paraklesis, the Divine Liturgy explained, and a guide to a Byzantine church. Each Roman-specific page has an Eastern counterpart.

Sanctify also has many color themes, including dark versions and themes that follow the liturgical season.

## How it’s built

- `index.html`: the whole site, a single-page app with no build step.
- `data/`: the hymns, the Akathist, and the Little Office, plus the book texts.
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
