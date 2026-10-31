/* =========================================================
   SANCTIFY'S LITTLE GAMES (a hidden corner of the site)
   St. Christopher's Crossing: carry the Child across the river, jumping the rocks, logs, and leaping fish.
     As the legend tells it, the Child grew heavier with every step; here he does too.
   Two by Two: find the pairs of animals and lead them into Noah's ark.
   Twelve Baskets: gather the loaves and fishes left over, and leave the stones.
   This file stands alone (the 404 page uses it without the rest of Sanctify) and draws in the theme's colors.
   ========================================================= */
(function(){
  'use strict';
  const root = document.documentElement;
  const css = (name, fallback) => (getComputedStyle(root).getPropertyValue(name) || '').trim() || fallback;
  const colors = () => ({
    ink:css('--ink', '#2a2118'), soft:css('--ink-soft', '#5a4d3c'), bg:css('--parchment-light', '#f6f0dc'), bg2:css('--parchment-dark', '#dccfa9'),
    wine:css('--wine', '#7a2426'), gold:css('--gold', '#a6824a'), water:css('--indigo', '#4b6a8f')
  });
  const best = {
    get(k){ try{ return Number(localStorage.getItem('sanctify.game.' + k)) || 0; }catch(e){ return 0; } },
    set(k, v){ try{ localStorage.setItem('sanctify.game.' + k, String(v)); }catch(e){} }
  };
  const typing = ev => ev.target && ev.target.closest && ev.target.closest('input, textarea, select, [contenteditable]');

  // The styles the games need, added once (the 404 page has no stylesheet of Sanctify's own)
  function addStyles(){
    if(document.getElementById('sgStyles')) return;
    const s = document.createElement('style');
    s.id = 'sgStyles';
    s.textContent = `
      .sg{position:relative; width:100%; max-width:640px; margin:0 auto; font-family:'Source Serif 4', Georgia, serif; color:var(--ink, #2a2118);}
      .sg canvas{display:block; width:100%; height:auto; border:1px solid var(--line, rgba(0,0,0,.18)); border-radius:14px; background:var(--parchment-light, #f6f0dc); touch-action:manipulation; cursor:pointer; -webkit-user-select:none; user-select:none;}
      .sg-baskets canvas{touch-action:none; cursor:none;}
      .sg-help{margin:8px 0 0; font-size:.85rem; color:var(--ink-soft, #5a4d3c); text-align:center;}
      .sg-bar{display:flex; justify-content:space-between; align-items:baseline; gap:10px; flex-wrap:wrap; margin:0 0 10px; font-size:.9rem; color:var(--ink-soft, #5a4d3c); font-variant-numeric:tabular-nums;}
      .sg-bar strong{font-family:'Cormorant Garamond', Georgia, serif; font-size:1.3rem; color:var(--ink, #2a2118);}
      .sg-grid{display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:10px; perspective:900px;}
      .sg-card{position:relative; aspect-ratio:1; padding:0; border:none; background:none; cursor:pointer; font:inherit;}
      .sg-card:focus-visible{outline:3px solid var(--wine, #7a2426); outline-offset:3px; border-radius:12px;}
      .sg-in{position:absolute; inset:0; transition:transform .35s cubic-bezier(.2, .7, .3, 1); transform-style:preserve-3d;}
      .sg-card.up .sg-in, .sg-card.done .sg-in{transform:rotateY(180deg);}
      .sg-face{position:absolute; inset:0; display:flex; align-items:center; justify-content:center; border-radius:12px; border:1px solid var(--line, rgba(0,0,0,.18)); backface-visibility:hidden; -webkit-backface-visibility:hidden;}
      .sg-back{background:var(--wine, #7a2426); color:var(--gold-light, #e0c48c);}
      .sg-back svg{width:38%; height:38%; opacity:.85;}
      .sg-front{background:var(--parchment-light, #f6f0dc); transform:rotateY(180deg); font-size:clamp(1.6rem, 7vw, 2.6rem);}
      .sg-card.done .sg-front{border-color:var(--gold, #a6824a); box-shadow:inset 0 0 0 2px var(--gold, #a6824a);}
      .sg-end{margin:14px 0 0; padding:14px 16px; border-radius:12px; border:1px solid var(--line, rgba(0,0,0,.18)); background:var(--parchment-light, #f6f0dc); text-align:center;}
      .sg-end p{margin:0 0 6px;}
      .sg-end blockquote{margin:6px 0; font-family:'Cormorant Garamond', Georgia, serif; font-style:italic; font-size:1.15rem;}
      .sg-end cite{display:block; font-style:normal; font-size:.8rem; color:var(--ink-soft, #5a4d3c); margin-bottom:10px;}
      .sg-btn{padding:8px 18px; border-radius:999px; border:1px solid var(--wine, #7a2426); background:var(--wine, #7a2426); color:var(--parchment-light, #f6f0dc); font:inherit; font-weight:600; cursor:pointer;}
      @media (prefers-reduced-motion:reduce){ .sg-in{transition:none;} }
    `;
    document.head.appendChild(s);
  }

  // A crisp canvas that keeps a fixed drawing size (w × h) and fills its container's width
  function makeCanvas(el, w, h, label){
    const c = document.createElement('canvas');
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', label);
    c.tabIndex = 0;
    el.appendChild(c);
    const ctx = c.getContext('2d');
    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2), cssW = c.clientWidth || w;
      c.width = Math.round(cssW * dpr); c.height = Math.round(cssW * h / w * dpr);
      ctx.setTransform(c.width / w, 0, 0, c.height / h, 0, 0);
    };
    fit();
    // fit again whenever the space it has changes (a phone turning, a pane opening)
    if(window.ResizeObserver) new ResizeObserver(fit).observe(c);
    return { c, ctx, fit };
  }
  // Runs step(dt) every frame until the game is taken off the page
  function loop(el, step, cleanup){
    let last = performance.now(), id = 0;
    const frame = now => {
      if(!el.isConnected){ cleanup(); return; }
      step(Math.min(50, now - last));
      last = now;
      id = requestAnimationFrame(frame);
    };
    id = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(id);
  }
  const font = (size, weight = 600) => `${weight} ${size}px 'Source Serif 4', Georgia, serif`;
  const title = size => `700 ${size}px 'Cormorant Garamond', Georgia, serif`;

  /* ---------- St. Christopher's Crossing ---------- */
  function christopher(el){
    addStyles();
    el.innerHTML = '';
    el.classList.add('sg', 'sg-runner');
    const W = 640, H = 220, WATER = 160;
    const { c, ctx, fit } = makeCanvas(el, W, H, 'St. Christopher’s Crossing: a game. Press space, the up arrow, or tap to jump.');
    el.insertAdjacentHTML('beforeend', '<p class="sg-help">Space, ↑, or tap to jump. Help St. Christopher carry the Child across the river.</p>');
    let state = 'ready', y = 0, vy = 0, dist = 0, speed = 0, obstacles = [], nextGap = 400, t = 0, shown = 0, banner = '', bannerT = 0;
    let top = best.get('christopher');
    const MILESTONES = [[200, 'The Child grows heavier…'], [450, 'Heavier still. Keep going!'], [800, 'He weighs as much as the world!'],
      [1200, 'You have carried the world, and the One who made it.']];
    const reset = () => { state = 'run'; y = 0; vy = 0; dist = 0; speed = 0.3; obstacles = []; nextGap = 380; shown = 0; banner = ''; };
    const score = () => Math.floor(dist / 12);
    const jump = () => {
      if(state !== 'run'){ reset(); return; }
      if(y === 0) vy = 0.55;
    };
    const onKey = ev => {
      if(typing(ev) || !el.isConnected) return;
      if(ev.key === ' ' || ev.key === 'ArrowUp' || ev.key === 'w' || ev.key === 'W'){
        // the page keeps its own space bar unless the game is on the screen
        const r = c.getBoundingClientRect();
        if(r.bottom < 0 || r.top > innerHeight) return;
        ev.preventDefault(); jump();
      }
    };
    document.addEventListener('keydown', onKey);
    c.addEventListener('pointerdown', ev => { ev.preventDefault(); jump(); });
    addEventListener('resize', fit);

    const spawn = () => {
      const r = Math.random(), late = score() > 150;
      if(r < 0.5) obstacles.push({ kind:'rock', x:W + 20, w:20 + Math.random() * 16, h:16 + Math.random() * 14 });
      else if(r < 0.78 || !late) obstacles.push({ kind:'log', x:W + 20, w:44 + Math.random() * 22, h:11 });
      else obstacles.push({ kind:'fish', x:W + 20, w:22, h:12, phase:0 });
    };
    const step = dt => {
      t += dt;
      if(state === 'run'){
        // the Child grows heavier: gravity rises a little as the paces add up
        const heavy = 1 + Math.min(score() / 1500, 0.45);
        speed = Math.min(0.78, 0.3 + score() / 2600);
        dist += speed * dt;
        if(y > 0 || vy > 0){ y += vy * dt; vy -= 0.0021 * heavy * dt; if(y <= 0){ y = 0; vy = 0; } }
        nextGap -= speed * dt;
        if(nextGap <= 0){ spawn(); nextGap = 230 + Math.random() * 300 + speed * 260; }
        obstacles.forEach(o => { o.x -= speed * dt; if(o.kind === 'fish') o.phase += dt * 0.006; });
        obstacles = obstacles.filter(o => o.x + o.w > -20);
        // collisions, with a little forgiveness at the edges
        const px1 = 70 - 10, px2 = 70 + 10, pyBottom = WATER - y, pyTop = pyBottom - 92;
        for(const o of obstacles){
          const oy = o.kind === 'fish' ? WATER - 6 - Math.max(0, Math.sin(o.phase)) * 52 : WATER + 4;
          const top2 = oy - o.h, x1 = o.x + 3, x2 = o.x + o.w - 3;
          if(x2 > px1 && x1 < px2 && pyBottom > top2 + 3 && pyTop < oy){
            state = 'over';
            if(score() > top){ top = score(); best.set('christopher', top); }
          }
        }
        while(shown < MILESTONES.length && score() >= MILESTONES[shown][0]){ banner = MILESTONES[shown][1]; bannerT = 2600; shown++; }
      }
      if(bannerT > 0) bannerT -= dt;
      draw();
    };

    const draw = () => {
      const k = colors();
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = k.bg; ctx.fillRect(0, 0, W, H);
      // the far bank, with reeds passing slowly
      ctx.fillStyle = k.bg2;
      ctx.beginPath(); ctx.moveTo(0, WATER - 8);
      for(let x = 0; x <= W; x += 20) ctx.lineTo(x, WATER - 14 - 10 * Math.sin((x + dist * 0.25) / 90) - 6 * Math.sin((x + dist * 0.25) / 37));
      ctx.lineTo(W, WATER); ctx.lineTo(0, WATER); ctx.fill();
      ctx.strokeStyle = k.soft; ctx.globalAlpha = 0.35; ctx.lineWidth = 1.2;
      for(let i = 0; i < 18; i++){
        const x = ((i * 53 - dist * 0.45) % (W + 40) + W + 40) % (W + 40) - 20;
        ctx.beginPath(); ctx.moveTo(x, WATER - 2); ctx.lineTo(x + 2, WATER - 18 - (i % 3) * 5); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // the river behind him
      ctx.fillStyle = k.water; ctx.globalAlpha = 0.18; ctx.fillRect(0, WATER - 2, W, H - WATER + 2); ctx.globalAlpha = 1;
      drawSaint(k);
      drawObstacles(k);   // in front of him, so it's clear what tripped him
      // the river in front: it covers his feet, so he wades
      ctx.fillStyle = k.water; ctx.globalAlpha = 0.28; ctx.fillRect(0, WATER + 8, W, H - WATER - 8); ctx.globalAlpha = 1;
      ctx.strokeStyle = k.water; ctx.globalAlpha = 0.6; ctx.lineWidth = 1.5;
      for(let row = 0; row < 3; row++){
        ctx.beginPath();
        for(let x = 0; x <= W; x += 8){
          const yy = WATER + 8 + row * 18 + 2.5 * Math.sin((x + dist * (0.9 + row * 0.25)) / 22 + row);
          x ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // the score
      ctx.fillStyle = k.soft; ctx.font = font(13); ctx.textAlign = 'right';
      ctx.fillText(`Best ${String(top).padStart(4, '0')}   Paces ${String(score()).padStart(4, '0')}`, W - 14, 22);
      ctx.textAlign = 'center';
      if(bannerT > 0 && state === 'run'){ ctx.globalAlpha = Math.min(1, bannerT / 500); ctx.fillStyle = k.wine; ctx.font = title(22); ctx.fillText(banner, W / 2, 50); ctx.globalAlpha = 1; }
      if(state === 'ready'){
        ctx.fillStyle = k.ink; ctx.font = title(28); ctx.fillText('St. Christopher’s Crossing', W / 2, 52);
        ctx.fillStyle = k.soft; ctx.font = font(14, 400); ctx.fillText('Carry the Child across the river. Tap or press space to begin.', W / 2, 76);
      }
      if(state === 'over'){
        ctx.fillStyle = k.ink; ctx.font = title(26); ctx.fillText('Christopher stumbled, but he will rise again.', W / 2, 50);
        ctx.fillStyle = k.soft; ctx.font = font(14, 400); ctx.fillText(`${score()} paces. Tap or press space to try again.`, W / 2, 74);
      }
    };
    const drawObstacles = k => {
      obstacles.forEach(o => {
        if(o.kind === 'rock'){
          ctx.fillStyle = k.soft; ctx.globalAlpha = 0.75;
          ctx.beginPath(); ctx.moveTo(o.x, WATER + 6);
          ctx.quadraticCurveTo(o.x + 2, WATER + 4 - o.h, o.x + o.w * 0.45, WATER + 4 - o.h);
          ctx.quadraticCurveTo(o.x + o.w, WATER + 6 - o.h * 0.9, o.x + o.w, WATER + 6); ctx.fill(); ctx.globalAlpha = 1;
        } else if(o.kind === 'log'){
          ctx.fillStyle = k.gold; ctx.strokeStyle = k.soft; ctx.lineWidth = 1;
          const yy = WATER + 4 - o.h;
          ctx.beginPath(); ctx.roundRect ? ctx.roundRect(o.x, yy, o.w, o.h, 5) : ctx.rect(o.x, yy, o.w, o.h); ctx.fill(); ctx.stroke();
          ctx.beginPath(); ctx.ellipse(o.x + o.w - 5, yy + o.h / 2, 3, o.h / 2 - 1.5, 0, 0, Math.PI * 2); ctx.stroke();
        } else {
          const yy = WATER - 6 - Math.max(0, Math.sin(o.phase)) * 52, up = Math.cos(o.phase) > 0;
          ctx.save(); ctx.translate(o.x + 11, yy - 6); ctx.rotate(up ? -0.5 : 0.5);
          ctx.fillStyle = k.wine;
          ctx.beginPath(); ctx.ellipse(0, 0, 11, 5, 0, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(16, -5); ctx.lineTo(16, 5); ctx.fill();
          ctx.fillStyle = k.bg; ctx.beginPath(); ctx.arc(-6, -1, 1.3, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
      });
    };
    const drawSaint = k => {
      const x = 70, by = WATER + 10 - y, stride = state === 'run' && y === 0 ? Math.sin(t * 0.012) * 7 : 0;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      // legs
      ctx.strokeStyle = k.ink; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(x - 3, by - 30); ctx.lineTo(x - 4 + stride, by); ctx.moveTo(x + 3, by - 30); ctx.lineTo(x + 4 - stride, by); ctx.stroke();
      // the staff (in the legend it blossomed into a palm)
      ctx.strokeStyle = k.gold; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x + 17, by - 82); ctx.lineTo(x + 19 + stride * 0.4, by + 2); ctx.stroke();
      ctx.strokeStyle = k.gold; ctx.lineWidth = 1.5;
      for(let i = 0; i < 4; i++){ ctx.beginPath(); ctx.moveTo(x + 17, by - 82); ctx.quadraticCurveTo(x + 17 + (i - 1.5) * 5, by - 94, x + 17 + (i - 1.5) * 8, by - 88 + Math.abs(i - 1.5) * 3); ctx.stroke(); }
      // his tunic
      ctx.fillStyle = k.wine;
      ctx.beginPath(); ctx.moveTo(x - 10, by - 64); ctx.lineTo(x + 10, by - 64); ctx.lineTo(x + 14, by - 26); ctx.lineTo(x - 14, by - 26); ctx.closePath(); ctx.fill();
      // the arm reaching to the staff
      ctx.strokeStyle = k.wine; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(x + 6, by - 60); ctx.lineTo(x + 17, by - 50); ctx.stroke();
      // his halo, head, and beard
      ctx.strokeStyle = k.gold; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x + 1, by - 73, 11, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#c89a68'; ctx.beginPath(); ctx.arc(x + 1, by - 73, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = k.ink; ctx.beginPath(); ctx.arc(x + 2, by - 68, 5, 0.1 * Math.PI, 0.9 * Math.PI); ctx.fill();
      // the Child on his shoulder, with a cross in his halo, blessing
      const cx = x - 7, cy = by - 92;
      ctx.strokeStyle = k.gold; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy - 7); ctx.lineTo(cx, cy - 4.5); ctx.moveTo(cx - 7, cy); ctx.lineTo(cx - 4.5, cy); ctx.moveTo(cx + 7, cy); ctx.lineTo(cx + 4.5, cy); ctx.stroke();
      ctx.fillStyle = '#d9ad7c'; ctx.beginPath(); ctx.arc(cx, cy, 4.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = k.gold; ctx.beginPath(); ctx.moveTo(cx - 5, cy + 4); ctx.lineTo(cx + 5, cy + 4); ctx.lineTo(cx + 6, cy + 14); ctx.lineTo(cx - 6, cy + 14); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#d9ad7c'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(cx + 4, cy + 7); ctx.lineTo(cx + 9, cy + 1); ctx.stroke();
    };
    draw();
    const stop = loop(el, step, () => { document.removeEventListener('keydown', onKey); removeEventListener('resize', fit); });
    return { destroy:() => { stop(); document.removeEventListener('keydown', onKey); removeEventListener('resize', fit); el.innerHTML = ''; } };
  }

  /* ---------- Two by Two (Noah's ark) ---------- */
  function ark(el){
    addStyles();
    el.innerHTML = '';
    el.classList.add('sg', 'sg-ark');
    const ANIMALS = ['🦁', '🐘', '🦒', '🐑', '🐫', '🦊', '🐻', '🕊️'];
    const NAMES = { '🦁':'lions', '🐘':'elephants', '🦒':'giraffes', '🐑':'sheep', '🐫':'camels', '🦊':'foxes', '🐻':'bears', '🕊️':'doves' };
    const cross = '<svg viewBox="0 0 64 64" aria-hidden="true" fill="currentColor"><path fill-rule="evenodd" d="M28.5 3h7v14h-7zM12 17h40v7H12zM28.5 24h7v37h-7z"/></svg>';
    let moves, open, done, busy;
    const start = () => {
      moves = 0; open = []; done = 0; busy = false;
      const deck = [...ANIMALS, ...ANIMALS].map(a => [a, Math.random()]).sort((p, q) => p[1] - q[1]).map(p => p[0]);
      const record = best.get('ark');
      el.innerHTML = `<div class="sg-bar"><strong>Two by Two</strong><span class="sg-moves">Moves: 0</span><span>Best: ${record ? record + ' moves' : 'not yet'}</span></div>
        <div class="sg-grid">${deck.map((a, i) => `<button class="sg-card" type="button" data-a="${a}" aria-label="Card ${i + 1}, face down"><span class="sg-in"><span class="sg-face sg-back">${cross}</span><span class="sg-face sg-front">${a}</span></span></button>`).join('')}</div>
        <p class="sg-help">Turn over two cards at a time and find each pair, to lead the animals into the ark.</p>`;
      el.querySelectorAll('.sg-card').forEach(b => b.addEventListener('click', () => turn(b)));
    };
    const turn = b => {
      if(busy || b.classList.contains('up') || b.classList.contains('done')) return;
      b.classList.add('up'); b.setAttribute('aria-label', NAMES[b.dataset.a]);
      open.push(b);
      if(open.length < 2) return;
      moves++;
      el.querySelector('.sg-moves').textContent = 'Moves: ' + moves;
      const [p, q] = open; open = [];
      if(p.dataset.a === q.dataset.a){
        [p, q].forEach(x => { x.classList.remove('up'); x.classList.add('done'); x.setAttribute('aria-label', NAMES[x.dataset.a] + ', in the ark'); });
        if(++done === ANIMALS.length) win();
      } else {
        busy = true;
        setTimeout(() => { [p, q].forEach(x => { x.classList.remove('up'); x.setAttribute('aria-label', 'Face down'); }); busy = false; }, 850);
      }
    };
    const win = () => {
      const record = best.get('ark');
      if(!record || moves < record) best.set('ark', moves);
      el.insertAdjacentHTML('beforeend', `<div class="sg-end" role="status"><p>All the animals are in the ark, in ${moves} moves${!record || moves < record ? ', your best yet' : ''}.</p>
        <blockquote>“two and two, male and female, went into the ark with Noah, as God had commanded Noah.”</blockquote><cite>Genesis 7:9</cite>
        <button class="sg-btn" type="button">Play again</button></div>`);
      el.querySelector('.sg-end .sg-btn').addEventListener('click', start);
    };
    start();
    return { destroy:() => { el.innerHTML = ''; } };
  }

  /* ---------- Twelve Baskets (the loaves and fishes) ---------- */
  function baskets(el){
    addStyles();
    el.innerHTML = '';
    el.classList.add('sg', 'sg-baskets');
    const W = 480, H = 320, GOAL = 12, PER = 5;
    const { c, ctx, fit } = makeCanvas(el, W, H, 'Twelve Baskets: a game. Move the basket with the mouse, a finger, or the arrow keys.');
    el.insertAdjacentHTML('beforeend', '<p class="sg-help">Move the basket with the mouse, a finger, or ← →. Gather the loaves and fishes; leave the stones.</p>');
    let state = 'ready', bx = W / 2, items = [], caught = 0, stones = 0, t = 0, next = 0, keys = { left:false, right:false };
    const reset = () => { state = 'run'; items = []; caught = 0; stones = 0; next = 400; };
    const full = () => Math.floor(caught / PER);
    const toX = ev => { const r = c.getBoundingClientRect(); return (ev.clientX - r.left) / r.width * W; };
    c.addEventListener('pointerdown', ev => { if(state !== 'run'){ reset(); } bx = toX(ev); });
    c.addEventListener('pointermove', ev => { bx = toX(ev); });
    const onKey = ev => {
      if(typing(ev) || !el.isConnected) return;
      const down = ev.type === 'keydown';
      if(ev.key === 'ArrowLeft' || ev.key === 'a' || ev.key === 'A'){ keys.left = down; ev.preventDefault(); }
      else if(ev.key === 'ArrowRight' || ev.key === 'd' || ev.key === 'D'){ keys.right = down; ev.preventDefault(); }
      else if(down && (ev.key === ' ' || ev.key === 'Enter') && state !== 'run' && document.activeElement === c){ ev.preventDefault(); reset(); }
    };
    document.addEventListener('keydown', onKey); document.addEventListener('keyup', onKey);
    addEventListener('resize', fit);
    const step = dt => {
      t += dt;
      if(state === 'run'){
        if(keys.left) bx -= 0.45 * dt;
        if(keys.right) bx += 0.45 * dt;
        bx = Math.max(36, Math.min(W - 36, bx));
        const pace = 1 + full() / 8;
        next -= dt;
        if(next <= 0){
          const r = Math.random();
          items.push({ kind:r < 0.2 + full() / 60 ? 'stone' : r < 0.6 ? 'loaf' : 'fish', x:24 + Math.random() * (W - 48), y:-16, v:(0.09 + Math.random() * 0.05) * pace, spin:Math.random() * 6 });
          next = (700 + Math.random() * 500) / pace;
        }
        items.forEach(o => { o.y += o.v * dt; o.spin += dt * 0.002; });
        items = items.filter(o => {
          if(o.y > H - 46 && o.y < H - 20 && Math.abs(o.x - bx) < 36){
            if(o.kind === 'stone'){ if(++stones >= 3) state = 'over'; }
            else if(++caught >= GOAL * PER){ state = 'won'; const b = best.get('baskets'); best.set('baskets', Math.max(b, 1)); }
            return false;
          }
          return o.y < H + 20;
        });
      }
      draw();
    };
    const loaf = (x, y, k) => { ctx.fillStyle = k.gold; ctx.beginPath(); ctx.ellipse(x, y, 13, 8, 0, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = k.bg; ctx.lineWidth = 1.4; ctx.beginPath(); for(let i = -1; i <= 1; i++){ ctx.moveTo(x + i * 5 - 2, y - 5); ctx.lineTo(x + i * 5 + 2, y + 5); } ctx.stroke(); };
    const fish = (x, y, k, a) => { ctx.save(); ctx.translate(x, y); ctx.rotate(Math.sin(a) * 0.3); ctx.fillStyle = k.water; ctx.beginPath(); ctx.ellipse(0, 0, 13, 6, 0, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(18, -6); ctx.lineTo(18, 6); ctx.fill(); ctx.fillStyle = k.bg; ctx.beginPath(); ctx.arc(-7, -1.5, 1.4, 0, Math.PI * 2); ctx.fill(); ctx.restore(); };
    const stone = (x, y, k) => { ctx.fillStyle = k.soft; ctx.globalAlpha = 0.8; ctx.beginPath(); ctx.ellipse(x, y, 10, 8, 0.4, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; };
    const basket = (x, y, w, h, k, fill) => {
      ctx.fillStyle = k.bg2; ctx.strokeStyle = k.soft; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x - w / 2, y); ctx.lineTo(x + w / 2, y); ctx.lineTo(x + w * 0.38, y + h); ctx.lineTo(x - w * 0.38, y + h); ctx.closePath(); ctx.fill(); ctx.stroke();
      if(fill){ ctx.fillStyle = k.gold; ctx.globalAlpha = 0.85; ctx.fillRect(x - w * 0.42, y + h * (1 - fill), w * 0.84, h * fill); ctx.globalAlpha = 1; }
      ctx.beginPath(); for(let i = 1; i < 3; i++){ ctx.moveTo(x - w / 2 + (w * 0.12) * i / 3, y + h * i / 3); ctx.lineTo(x + w / 2 - (w * 0.12) * i / 3, y + h * i / 3); } ctx.stroke();
    };
    const draw = () => {
      const k = colors();
      ctx.clearRect(0, 0, W, H); ctx.fillStyle = k.bg; ctx.fillRect(0, 0, W, H);
      // the hillside where the five thousand sat
      ctx.fillStyle = k.bg2; ctx.beginPath(); ctx.moveTo(0, H - 18); ctx.quadraticCurveTo(W / 2, H - 46, W, H - 22); ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.fill();
      // the twelve baskets along the top
      for(let i = 0; i < GOAL; i++){
        const fillAmt = i < full() ? 1 : i === full() ? (caught % PER) / PER : 0;
        basket(26 + i * ((W - 52) / (GOAL - 1)), 14, 22, 16, k, fillAmt);
      }
      ctx.fillStyle = k.soft; ctx.font = font(12); ctx.textAlign = 'left';
      ctx.fillText(`${full()} of ${GOAL} baskets`, 12, 50);
      ctx.textAlign = 'right'; ctx.fillText('Stones: ' + '●'.repeat(stones) + '○'.repeat(3 - stones), W - 12, 50);
      items.forEach(o => o.kind === 'loaf' ? loaf(o.x, o.y, k) : o.kind === 'fish' ? fish(o.x, o.y, k, o.spin) : stone(o.x, o.y, k));
      basket(bx, H - 44, 72, 30, k, 0);
      ctx.textAlign = 'center';
      if(state === 'ready'){
        ctx.fillStyle = k.ink; ctx.font = title(28); ctx.fillText('Twelve Baskets', W / 2, 120);
        ctx.fillStyle = k.soft; ctx.font = font(14, 400); ctx.fillText('Gather what is left over. Tap or click to begin.', W / 2, 146);
      } else if(state === 'over'){
        ctx.fillStyle = k.ink; ctx.font = title(24); ctx.fillText('Three stones! Bread, not stones.', W / 2, 120);
        ctx.fillStyle = k.soft; ctx.font = font(14, 400); ctx.fillText(`${full()} baskets gathered. Tap to try again.`, W / 2, 146);
      } else if(state === 'won'){
        ctx.fillStyle = k.ink; ctx.font = title(22); ctx.fillText('“And they all ate and were satisfied.', W / 2, 112);
        ctx.fillText('And they took up twelve baskets full of', W / 2, 138); ctx.fillText('the broken pieces left over.”', W / 2, 164);
        ctx.fillStyle = k.soft; ctx.font = font(13, 400); ctx.fillText('Matthew 14:20 · Tap to play again', W / 2, 190);
      }
    };
    draw();
    const cleanup = () => { document.removeEventListener('keydown', onKey); document.removeEventListener('keyup', onKey); removeEventListener('resize', fit); };
    const stop = loop(el, step, cleanup);
    return { destroy:() => { stop(); cleanup(); el.innerHTML = ''; } };
  }

  window.SanctifyGames = { christopher, ark, baskets };
})();
