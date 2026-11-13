'use strict';
// Snow engine for one display. Canvas 2D, everything in CSS px; DPR applied via transform.
const api = window.oppoq;
const cv = document.getElementById('c');
const ctx = cv.getContext('2d');
const BIN = 3, TAU = Math.PI * 2, WMAX = 18, GMAX = 110;
const FPS = 30; // ponytail: 30fps keeps the GPU cost of two full-screen transparent windows ~40% of one core; 60 doubles it
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, k) => a + (b - a) * k;
const easeBack = u => { const c = 1.7; return 1 + (c + 1) * (u - 1) ** 3 + c * (u - 1) ** 2; };
const COLORS = ['#ff4d6d', '#ffd166', '#06d6a0', '#4cc9f0', '#f72585', '#ff9f43'];

let W = innerWidth, H = innerHeight, DPR = devicePixelRatio || 1, GROUND = H, TOP = 0;
let S = null, active = false, raf = 0, last = 0, t = 0, frameN = 0, wind = 0;
let G = new Float32Array(Math.ceil(W / BIN)); // ground drift heights
const surf = new Map();                         // window drifts by window id
let order = [];                                 // same, front to back
const flakes = [], parts = [], sparks = [], stacks = [];
let mx = -1e4, my = -1e4, pmx = null, pmy = 0, mvx = 0, mvy = 0;
let held = null, dragStack = null, dragOff = 0, capture = false, cursor = '';
let sleigh = null, nextSleigh = rand(40, 90), exc = null, excCool = 20, ballT = rand(15, 35);
let bulbs = [], wires = [], garlandA = 0;
const MAX_STACKS = 3;

/* ---------------- helpers ---------------- */
const R0 = () => ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
function T(sx, x, y, rot = 0) { const c = Math.cos(rot) * DPR, s = Math.sin(rot) * DPR; ctx.setTransform(c * sx, s * sx, -s, c, x * DPR, y * DPR); }
function ell(x, y, rx, ry, rot = 0) { ctx.beginPath(); ctx.ellipse(x, y, Math.max(.01, rx), Math.max(.01, ry), rot, 0, TAU); ctx.fill(); }
function rr(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
const add = p => { if (parts.length < 3000) parts.push(p); };
const avgG = () => { let s = 0; for (const v of G) s += v; return s / G.length; };
const groundTop = x => GROUND - (S.ground ? G[clamp((x / BIN) | 0, 0, G.length - 1)] * .55 : 0);

/* ---------------- sprites ---------------- */
// All sprites live in one atlas canvas so the GPU can batch the hundreds of draws per frame.
const ATLAS = document.createElement('canvas'); ATLAS.width = 512; ATLAS.height = 192;
const actx = ATLAS.getContext('2d');
let slot = 0;
function sprite(size, draw) {
  const sp = { x: (slot % 8) * 64, y: ((slot / 8) | 0) * 64, n: size * 2 }; slot++;
  actx.save(); actx.beginPath(); actx.rect(sp.x, sp.y, 64, 64); actx.clip();
  actx.translate(sp.x, sp.y); actx.scale(2, 2); draw(actx, size / 2); actx.restore();
  return sp;
}
const blit = (sp, x, y, w, h, g = ctx) => g.drawImage(ATLAS, sp.x, sp.y, sp.n, sp.n, x, y, w, h);
const DOT = sprite(16, (g, m) => {
  const gr = g.createRadialGradient(m, m, 0, m, m, m);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.3, 'rgba(255,255,255,.92)');
  gr.addColorStop(.55, 'rgba(175,200,245,.3)'); gr.addColorStop(1, 'rgba(175,200,245,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 16, 16);
});
const crystal = arms => sprite(32, (g, m) => {
  g.translate(m, m); g.strokeStyle = '#fff'; g.lineCap = 'round'; g.lineWidth = 1.5;
  g.shadowColor = 'rgba(150,185,255,.95)'; g.shadowBlur = 3;
  g.beginPath();
  for (let k = 0; k < 6; k++) {
    g.save(); g.rotate(k * TAU / 6);
    g.moveTo(0, 0); g.lineTo(0, -12.5);
    for (const [y, l] of arms) { g.moveTo(0, y); g.lineTo(-l, y - l); g.moveTo(0, y); g.lineTo(l, y - l); }
    g.restore();
  }
  g.stroke();
  g.beginPath(); g.arc(0, 0, 2, 0, TAU); g.fillStyle = '#fff'; g.fill();
});
const CRYSTALS = [crystal([[-5, 3], [-9, 2.5]]), crystal([[-4, 4], [-8, 3], [-11, 1.5]]), crystal([[-7, 4.5]])];
const glowSprite = c => sprite(32, (g, m) => {
  const gr = g.createRadialGradient(m, m, 0, m, m, m);
  gr.addColorStop(0, c + 'ee'); gr.addColorStop(.35, c + '66'); gr.addColorStop(1, c + '00');
  g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
});
const GLOWS = COLORS.map(glowSprite), GOLD = glowSprite('#ffd98a'), WARM = glowSprite('#ffa94d');
const GLITTER = [GOLD, GLOWS[1], GLOWS[3], DOT];
const BULBS = COLORS.map(c => sprite(16, g => { // cap + glass + glint, pre-rendered (per-frame paths cost the GPU ~30%)
  g.fillStyle = '#2f3a2c'; g.fillRect(6.5, 0, 3, 2.6);
  g.fillStyle = c; g.beginPath(); g.ellipse(8, 6, 2.6, 4, 0, 0, TAU); g.fill();
  g.fillStyle = 'rgba(255,255,255,.8)'; g.beginPath(); g.ellipse(7.2, 4.8, .7, 1.2, 0, 0, TAU); g.fill();
}));

/* ---------------- IPC ---------------- */
api.on('geo', g => {
  W = g.w; H = g.h; GROUND = g.ground; TOP = g.top; DPR = devicePixelRatio || 1;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  const old = G; G = new Float32Array(Math.ceil(W / BIN)); G.set(old.subarray(0, Math.min(old.length, G.length)));
  layoutGarland();
});
api.on('settings', s => {
  const first = !S; S = s;
  cv.style.opacity = s.opacity / 100;
  if (first) for (let k = 0, n = target(); k < n; k++) flakes.push(newFlake({}, true));
  start();
});
api.on('active', a => { active = a; if (!a && capture) { capture = false; api.send('capture', false); } start(); });
api.on('wins', onWins);
api.on('cmd', c => {
  if (c === 'clear') { clearAll(); [...stacks].forEach(poof); }
  else if (c === 'sleigh') startSleigh();
  else if (c === 'excavator' && !exc) startExc();
  else if (c === 'snowman') { const x = freeX(); if (x != null) addStack(mkStack(x, [24, 18, 13])); }
});
function start() { if (!raf && active && S) { last = performance.now(); raf = requestAnimationFrame(frame); } }

/* ---------------- windows ---------------- */
function resample(d, n) { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = d[Math.min(d.length - 1, Math.floor(i * d.length / n))]; return o; }
function onWins(list) {
  const seen = new Set(); order = [];
  list.forEach((r, z) => {
    seen.add(r.id);
    const n = Math.max(1, Math.ceil(r.w / BIN));
    let o = surf.get(r.id);
    if (!o) { o = { id: r.id, x: r.x, y: r.y, w: r.w, h: r.h, d: new Float32Array(n), ice: mkIce(r.id), spill: 0 }; surf.set(r.id, o); }
    else {
      const sp = Math.hypot(r.x - o.x, r.y - o.y);
      if (sp > 10) shake(o, Math.min(1, (sp - 10) / 50)); // a gentle drag carries the snow, a shake throws it off
      if (o.d.length !== n) o.d = resample(o.d, n);
      Object.assign(o, { x: r.x, y: r.y, w: r.w, h: r.h });
    }
    o.z = z; order.push(o);
  });
  for (const [id, o] of surf) if (!seen.has(id)) { shake(o, 1); surf.delete(id); }
}
function shake(o, frac) {
  let acc = 0;
  for (let i = 0; i < o.d.length; i++) {
    const a = o.d[i] * frac; o.d[i] -= a; acc += a;
    if (acc > 30 || (i === o.d.length - 1 && acc > 1)) { clump(o.x + i * BIN, o.y - 3, acc, rand(-30, 30)); acc = 0; }
  }
  if (frac > .3) for (const c of o.ice) if (c.len > 2) {
    add({ k: 'i', x: o.x + c.f * o.w, y: o.y, vx: rand(-10, 10), vy: 0, len: c.len, w: c.w, rot: 0, vr: rand(-3, 3), life: 0, max: 4 });
    c.len = 0;
  }
}
const clump = (x, y, vol, vx) => add({ k: 'c', x, y, vx, vy: rand(-20, 10), vol, r: Math.min(7, 1.2 + Math.sqrt(vol) * .6), life: 0, max: 6 });
function covered(x, y, z) {
  for (let k = 0; k < z; k++) { const o = order[k]; if (x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h) return true; }
  return false;
}
// where does something falling from (x,py) to (x,y) land? → [heights, bin, max]
function hit(x, py, y) {
  if (S.windows) for (const o of order) {
    if (o.y < 6 || x < o.x || x >= o.x + o.w) continue;
    const i = ((x - o.x) / BIN) | 0, top = o.y - o.d[i];
    if (py <= top && y >= top && !covered(x, top - 1, o.z)) return [o.d, i, WMAX];
  }
  if (S.ground && x >= 0 && x < W) { const i = (x / BIN) | 0; if (y >= GROUND - G[i]) return [G, i, GMAX]; }
  return null;
}
function deposit(d, i, a, max) {
  for (let j = -1; j <= 1; j++) { const q = i + j; if (q >= 0 && q < d.length) d[q] = Math.min(max, d[q] + a * (j ? .25 : .5)); }
}
function depositWide(d, i, vol, max, m) {
  const c = vol / (2 * m + 1);
  for (let q = i - m; q <= i + m; q++) if (q >= 0 && q < d.length) d[q] = Math.min(max, d[q] + c);
}
function relax(d, s) { // angle of repose
  const n = d.length, fwd = frameN & 1;
  for (let k = 0; k < n - 1; k++) {
    const i = fwd ? k : n - 2 - k, df = d[i] - d[i + 1];
    if (df > s) { const m = (df - s) * .3; d[i] -= m; d[i + 1] += m; }
    else if (df < -s) { const m = (-df - s) * .3; d[i] += m; d[i + 1] -= m; }
    else { const m = df * .05; d[i] -= m; d[i + 1] += m; } // gentle smoothing so the drift isn't jagged
  }
}

/* ---------------- icicles ---------------- */
function mulberry(a) { return () => { a = (a + 0x6D2B79F5) | 0; let q = Math.imul(a ^ (a >>> 15), 1 | a); q = (q + Math.imul(q ^ (q >>> 7), 61 | q)) ^ q; return ((q ^ (q >>> 14)) >>> 0) / 4294967296; }; }
function mkIce(id) {
  let h = 2166136261; for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const r = mulberry(h);
  return Array.from({ length: 3 + ((r() * 6) | 0) }, () => ({ f: .05 + r() * .9, len: 0, max: 5 + r() * 12, w: 2.2 + r() * 2.4, drip: 4 + r() * 16 }));
}
function updIce(o, dt) {
  for (const c of o.ice) {
    const dep = o.d[Math.min(o.d.length - 1, (c.f * o.d.length) | 0)];
    if (S.icicles && dep > 5) c.len = Math.min(c.max, c.len + dt * .2);
    else if (dep < 1.5 || !S.icicles) c.len = Math.max(0, c.len - dt * .4);
    if (c.len > c.max * .7 && (c.drip -= dt) < 0) { c.drip = rand(5, 18); add({ k: 'd', x: o.x + c.f * o.w, y: o.y + c.len, vx: 0, vy: 0, life: 0, max: 3 }); }
  }
}
function drawIce(o) {
  for (const c of o.ice) {
    if (c.len < .8) continue;
    const x = o.x + c.f * o.w, y = o.y, L = c.len, w = c.w * Math.min(1, L / 4 + .3);
    ctx.beginPath(); ctx.moveTo(x - w / 2, y);
    ctx.quadraticCurveTo(x - w * .2, y + L * .55, x, y + L); ctx.quadraticCurveTo(x + w * .15, y + L * .5, x + w / 2, y); ctx.closePath();
    ctx.fillStyle = 'rgba(228,240,255,.88)'; ctx.fill();
    ctx.strokeStyle = 'rgba(130,160,215,.55)'; ctx.lineWidth = .6; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - w * .22, y + 1); ctx.lineTo(x - w * .05, y + L * .7);
    ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = .7; ctx.stroke();
  }
}

/* ---------------- flakes ---------------- */
const target = () => S.paused ? 0 : Math.round(950 * (W * H) / (1920 * 1080) * Math.pow(S.intensity / 100, 1.3));
function newFlake(f, anywhere) {
  const k = Math.random(), L = k < .5 ? 0 : k < .87 ? 1 : 2;
  f.L = L;
  f.rb = L === 0 ? rand(.7, 1.2) : L === 1 ? rand(1.2, 2.1) : rand(3.2, 5.5);
  f.vy = (L === 0 ? rand(20, 34) : L === 1 ? rand(36, 58) : rand(55, 80)) * (.8 + S.intensity / 200);
  f.depth = L === 0 ? .55 : L === 1 ? .8 : 1;
  f.a = L === 0 ? rand(.35, .55) : L === 1 ? rand(.65, .85) : rand(.8, .95);
  f.amp = rand(6, 20) * f.depth; f.fq = rand(.4, 1.1); f.ph = rand(0, TAU);
  f.rot = rand(0, TAU); f.vr = rand(-1.2, 1.2); f.spr = CRYSTALS[(Math.random() * 3) | 0];
  const lead = Math.abs(wind) * 3; // spawn upwind so a strong wind doesn't leave an empty strip
  f.x = rand(-20, W + lead + 20) - (wind > 0 ? lead : 0);
  f.y = anywhere ? rand(-20, GROUND) : rand(-50, -8);
  f.vx = wind * f.depth;
  return f;
}
function updWind() {
  const b = S.wind * 1.3;
  wind = b + (S.gusts ? (Math.sin(t * .23) + Math.sin(t * .61 + 1.3) * .7 + Math.sin(t * 1.7 + .4) * .3) * (10 + Math.abs(b) * .45) : 0);
}
function updFlakes(dt) {
  const tgt = target(), m = .6 + S.size / 100;
  for (let k = 0; k < Math.min(6, tgt - flakes.length); k++) flakes.push(newFlake({}, false));
  for (let k = flakes.length - 1; k >= 0; k--) {
    const f = flakes[k], py = f.y;
    f.ph += dt * f.fq; f.rot += f.vr * dt;
    f.vx += (wind * f.depth + Math.cos(f.ph) * f.amp - f.vx) * Math.min(1, dt * 1.5);
    const dx = f.x - mx, dy = f.y - my, d2 = dx * dx + dy * dy;
    if (d2 < 4900 && !held) { const s = 1 - Math.sqrt(d2) / 70; f.vx += mvx * s * dt * 4; f.y += mvy * s * dt * .6; }
    f.x += f.vx * dt; f.y += f.vy * dt;
    if (f.vx > 0 && f.x > W + 40) f.x -= W + 80; else if (f.vx < 0 && f.x < -40) f.x += W + 80;
    let gone = f.y > H + 10 || (!S.ground && f.y > GROUND);
    if (!gone && f.y > 0) { const h = hit(f.x, py, f.y); if (h) { deposit(h[0], h[1], Math.min(1.4, f.rb * m * .55), h[2]); gone = true; } }
    if (gone) { if (flakes.length > tgt) { flakes[k] = flakes[flakes.length - 1]; flakes.pop(); } else newFlake(f, false); }
  }
}
function drawFlakes() {
  const m = .6 + S.size / 100;
  for (const f of flakes) {
    const r = f.rb * m;
    ctx.globalAlpha = f.a;
    if (f.L < 2) blit(DOT, f.x - r * 2.2, f.y - r * 2.2, r * 4.4, r * 4.4);
    else { T(1, f.x, f.y, f.rot); blit(f.spr, -r * 1.3, -r * 1.3, r * 2.6, r * 2.6); }
  }
  R0(); ctx.globalAlpha = 1;
}

/* ---------------- drifts ---------------- */
function updSurfaces(dt) {
  const melt = S.melt ? dt * .03 : 0;
  relax(G, 1.4);
  if (melt) for (let i = 0; i < G.length; i++) G[i] = Math.max(0, G[i] - melt);
  for (const o of order) {
    const d = o.d;
    relax(d, 1);
    if (melt) for (let i = 0; i < d.length; i++) d[i] = Math.max(0, d[i] - melt);
    for (const [i, ex] of [[0, o.x - 3], [d.length - 1, o.x + o.w + 3]]) {
      if (d[i] <= 2.5) continue;
      o.spill += d[i] - 2.5; d[i] = 2.5; // snow slips over the window's edge
      if (o.spill > 8) { clump(ex, o.y - 3, o.spill, (i ? 1 : -1) * rand(10, 30)); o.spill = 0; }
    }
    updIce(o, dt);
  }
}
function drawDrift(d, x0, base) {
  // only the span that actually has snow → fewer vertices for the GPU
  let a = 0, b = d.length - 1, top = 0;
  while (a <= b && d[a] < .3) a++;
  while (b >= a && d[b] < .3) b--;
  if (a > b) return;
  a = Math.max(0, a - 1); b = Math.min(d.length - 1, b + 1);
  ctx.beginPath(); ctx.moveTo(x0 + a * BIN, base);
  for (let i = a; i <= b; i++) { ctx.lineTo(x0 + i * BIN, base - d[i]); if (d[i] > top) top = d[i]; }
  ctx.lineTo(x0 + b * BIN, base); ctx.closePath();
  const g = ctx.createLinearGradient(0, base - top, 0, base);
  g.addColorStop(0, '#ffffff'); g.addColorStop(.55, '#f3f7ff'); g.addColorStop(1, '#d3def3');
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = 'rgba(150,175,220,.5)'; ctx.lineWidth = .7; ctx.stroke();
}
// cursor sweeps snow aside
function brushDrift(d, x0, base, z) {
  if (my > base + 2 || my < base - 130 || (z >= 0 && covered(mx, my, z))) return;
  const R = 18, i0 = Math.max(0, Math.floor((mx - R - x0) / BIN)), i1 = Math.min(d.length - 1, Math.ceil((mx + R - x0) / BIN));
  for (let i = i0; i <= i1; i++) {
    const dx = x0 + i * BIN - mx, keep = Math.max(0, base - (my + Math.sqrt(Math.max(0, R * R - dx * dx)) * .7));
    if (d[i] <= keep + .3) continue;
    const rem = d[i] - keep; d[i] = keep;
    for (let q = 0; q < 3; q++) if (Math.random() < rem * .12) powder(x0 + i * BIN, base - keep, mvx * rand(.15, .45), -rand(40, 160) + Math.min(0, mvy) * .2);
  }
}
const powder = (x, y, vx, vy, nod) => add({ k: 'p', x, y, vx: vx + rand(-30, 30), vy, r: rand(.8, 1.7), life: 0, max: rand(.6, 1.2), nod });
function clearAll() {
  for (const [d, x0, base] of [[G, 0, GROUND], ...order.map(o => [o.d, o.x, o.y])]) {
    for (let i = 0; i < d.length; i += 3) if (d[i] > 2) powder(x0 + i * BIN, base - d[i], 0, -rand(40, 140), true);
    d.fill(0);
  }
  for (const o of order) for (const c of o.ice) c.len = 0;
}

/* ---------------- sparkles on the snow ---------------- */
function updSparks(dt) {
  if (Math.random() < dt * 5) {
    const pool = [null, null, ...order];
    const o = pool[(Math.random() * pool.length) | 0], d = o ? o.d : G, i = (Math.random() * d.length) | 0;
    if (d[i] > 3 && (!o || (o.y > 4 && !covered(o.x + i * BIN, o.y - d[i] - 1, o.z)))) sparks.push({ o, i, life: 0, max: rand(.5, 1.3), s: rand(1.8, 3.2), c: ['#8fc2ff', '#ffe08a', '#c4b5ff'][(Math.random() * 3) | 0] });
  }
  for (let k = sparks.length - 1; k >= 0; k--) if ((sparks[k].life += dt) > sparks[k].max) sparks.splice(k, 1);
}
function drawSparks() {
  ctx.lineWidth = .8;
  for (const p of sparks) {
    if (p.o && surf.get(p.o.id) !== p.o) continue;
    const d = p.o ? p.o.d : G, x = (p.o ? p.o.x : 0) + p.i * BIN, y = (p.o ? p.o.y : GROUND) - (d[p.i] ?? 0) + 1.8;
    const a = Math.sin(Math.PI * p.life / p.max), L = p.s * a;
    ctx.globalAlpha = a; ctx.strokeStyle = p.c;
    ctx.beginPath(); ctx.moveTo(x - L, y); ctx.lineTo(x + L, y); ctx.moveTo(x, y - L); ctx.lineTo(x, y + L); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/* ---------------- particles ---------------- */
function updParts(dt) {
  for (let k = parts.length - 1; k >= 0; k--) {
    const p = parts[k], py = p.y;
    p.life += dt;
    let dead = p.life > p.max;
    switch (p.k) {
      case 'p': p.vy += 380 * dt; p.vx *= 1 - dt * 1.5; break;
      case 'c': case 'd': p.vy += 900 * dt; break;
      case 'i': p.vy += 900 * dt; p.rot += p.vr * dt; break;
      case 'g': p.vy += 12 * dt; p.vx *= 1 - dt * .8; break;
      case 's': p.vy *= 1 - dt * .5; p.vx *= 1 - dt; p.r += dt * 6; break;
    }
    p.x += p.vx * dt; p.y += p.vy * dt;
    if ((p.k === 'c' || p.k === 'i' || p.k === 'd' || p.k === 'p') && p.vy > 0) {
      const h = hit(p.x, py, p.y);
      if (h) {
        dead = true;
        if (p.k === 'c') { depositWide(h[0], h[1], p.vol, h[2], 1 + Math.round(p.r / BIN)); for (let q = 0; q < 3 + p.vol / 6 && q < 14; q++) powder(p.x, p.y - 2, rand(-50, 50), -rand(30, 110), true); }
        else if (p.k === 'i') for (let q = 0; q < 6; q++) powder(p.x, p.y - 2, rand(-60, 60), -rand(40, 130), true);
        else if (p.k === 'p' && !p.nod) deposit(h[0], h[1], .15, h[2]);
      }
      if (p.y > H + 20) dead = true;
    }
    if (dead) { parts[k] = parts[parts.length - 1]; parts.pop(); }
  }
}
function drawParts() {
  for (const p of parts) {
    const u = p.life / p.max;
    switch (p.k) {
      case 'p': ctx.globalAlpha = 1 - u; blit(DOT, p.x - p.r * 2, p.y - p.r * 2, p.r * 4, p.r * 4); break;
      case 'c':
        ctx.globalAlpha = 1; ctx.fillStyle = '#fbfdff'; ell(p.x, p.y, p.r, p.r * .9);
        ctx.strokeStyle = 'rgba(140,165,210,.6)'; ctx.lineWidth = .7; ctx.stroke();
        ell(p.x + p.r * .5, p.y - p.r * .45, p.r * .6, p.r * .55); break;
      case 'd': ctx.globalAlpha = .85; ctx.fillStyle = '#cfe4ff'; ell(p.x, p.y, 1.1, 2); break;
      case 'i':
        T(1, p.x, p.y, p.rot); ctx.globalAlpha = .9; ctx.fillStyle = 'rgba(228,240,255,.9)';
        ctx.beginPath(); ctx.moveTo(-p.w / 2, 0); ctx.lineTo(0, p.len); ctx.lineTo(p.w / 2, 0); ctx.closePath(); ctx.fill(); R0(); break;
      case 's': ctx.globalAlpha = .3 * (1 - u); ctx.fillStyle = '#a3a9bb'; ell(p.x, p.y, p.r, p.r); break;
    }
  }
  ctx.globalAlpha = 1;
}
function drawGlitter() {
  ctx.globalCompositeOperation = 'lighter';
  for (const p of parts) {
    if (p.k !== 'g') continue;
    ctx.globalAlpha = (1 - p.life / p.max) * (.55 + .45 * Math.sin(p.life * 14 + p.ph));
    const s = p.r * 6; blit(GLITTER[p.c], p.x - s / 2, p.y - s / 2, s, s);
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
}

/* ---------------- garland ---------------- */
function layoutGarland() {
  bulbs = []; wires = [];
  const segs = Math.max(2, Math.round(W / 240)), sw = W / segs, y = TOP + 1;
  let idx = 0;
  for (let s = 0; s < segs; s++) {
    const x0 = s * sw, sag = 10 + (s % 3) * 2;
    wires.push([x0, y, x0 + sw / 2, y + sag * 2, x0 + sw, y]);
    const nb = Math.round(sw / 30);
    for (let k = 1; k < nb; k++) {
      const u = k / nb;
      bulbs.push({ x: x0 + sw * u, y: y + 4 * sag * u * (1 - u), a: Math.atan(4 * sag * (1 - 2 * u) / sw) * .3, c: idx % COLORS.length, i: idx++, ph: rand(0, TAU), fq: rand(.8, 2.2) });
    }
  }
}
function pattern(m, b) {
  switch (m) {
    case 0: return .55 + .45 * Math.sin(t * 1.4 + b.i * .35);                                   // slow breathing wave
    case 1: { const p = (((b.i - t * 7) % 8) + 8) % 8; return .3 + .7 * Math.max(0, 1 - Math.abs(p - 1) / 1.5); } // chase
    case 2: return .3 + .7 * Math.pow(.5 + .5 * Math.sin(t * b.fq * 2 + b.ph), 3);                 // twinkle
    default: return .3 + .7 * (.5 + .5 * Math.sin(t * 3 + (b.i % 2) * Math.PI));                    // alternate
  }
}
// fade the garland out while any window reaches the top of the screen (maximized apps keep their title-bar buttons clear)
function updGarland(dt) {
  const want = S.garland && !order.some(o => o.y <= TOP + 30 && o.y + o.h > TOP) ? 1 : 0;
  garlandA = clamp(garlandA + (want ? dt : -dt) * 3, 0, 1);
}
function drawGarland() {
  if (garlandA <= 0) return;
  const A = garlandA;
  ctx.globalAlpha = A; ctx.strokeStyle = 'rgba(28,52,38,.9)'; ctx.lineWidth = 1.4; ctx.beginPath();
  for (const [x0, y0, cx, cy, x1, y1] of wires) { ctx.moveTo(x0, y0); ctx.quadraticCurveTo(cx, cy, x1, y1); }
  ctx.stroke();
  const m = Math.floor(t / 14) % 4, f = clamp((t % 14) / 1.2, 0, 1);
  for (const b of bulbs) b.br = lerp(pattern((m + 3) % 4, b), pattern(m, b), f);
  ctx.globalCompositeOperation = 'lighter';
  for (const b of bulbs) { ctx.globalAlpha = A * b.br * .85; blit(GLOWS[b.c], b.x - 13, b.y - 7.5, 26, 26); }
  ctx.globalCompositeOperation = 'source-over';
  for (const b of bulbs) { ctx.globalAlpha = A * (.55 + .45 * b.br); blit(BULBS[b.c], b.x - 8, b.y - .5, 16, 16); }
  ctx.globalAlpha = 1;
}

/* ---------------- Santa's sleigh ---------------- */
function startSleigh() {
  const d = Math.random() < .5 ? 1 : -1;
  sleigh = { dir: d, x: d > 0 ? -320 : W + 320, y0: TOP + 70 + H * rand(.04, .2), ph: 0, y: 0, tilt: 0 };
}
function updSleigh(dt) {
  if (!sleigh) { if (S.sleigh && (nextSleigh -= dt) < 0) { nextSleigh = rand(240, 480); startSleigh(); } return; }
  const s = sleigh, v = 190;
  s.ph += dt; s.x += s.dir * v * dt;
  const u = clamp(s.dir > 0 ? s.x / W : 1 - s.x / W, 0, 1);
  const ny = s.y0 - Math.sin(u * Math.PI) * 45 + Math.sin(s.ph * 2.2) * 5;
  if (s.y) s.tilt = lerp(s.tilt, Math.atan((ny - s.y) / dt / v), .1);
  s.y = ny;
  for (let k = 0; k < 2; k++) add({ k: 'g', x: s.x - s.dir * 30 + rand(-4, 4), y: s.y + 7 + rand(-3, 3), vx: -s.dir * rand(10, 50), vy: rand(-8, 20), r: rand(.8, 2), life: 0, max: rand(1.5, 2.8), c: (Math.random() * 4) | 0, ph: rand(0, TAU) });
  if (s.dir > 0 ? s.x > W + 330 : s.x < -330) sleigh = null;
}
function deer(x, y, lp) {
  const s = Math.sin(lp);
  const leg = (bx, a, col) => {
    ctx.strokeStyle = col; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.moveTo(x + bx, y + 3);
    const kx = x + bx + Math.sin(a) * 6, ky = y + 3 + Math.cos(a) * 6;
    ctx.lineTo(kx, ky); ctx.lineTo(kx + Math.sin(a * 1.6 - .5) * 6, ky + Math.cos(a * 1.6 - .5) * 6); ctx.stroke();
  };
  ctx.lineCap = 'round';
  leg(-9, -.9 * s - .3, '#5a3a22'); leg(9, .9 * s + .2, '#5a3a22');
  ctx.fillStyle = '#f5efe6'; ell(x - 14, y - 3, 2.2, 2);
  ctx.fillStyle = '#8b5a33'; ell(x, y, 14, 6.5);
  ctx.fillStyle = '#c9a27a'; ell(x + 1, y + 3, 9, 2.4);
  leg(-7, .9 * s - .3, '#7a4c2a'); leg(11, -.9 * s + .2, '#7a4c2a');
  ctx.strokeStyle = '#8b5a33'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(x + 9, y - 2); ctx.lineTo(x + 16, y - 10); ctx.stroke();
  ctx.fillStyle = '#8b5a33'; ell(x + 19, y - 12, 5.5, 3.6, .3);
  ctx.fillStyle = '#5a3a22'; ell(x + 23.5, y - 10.2, 2, 1.6);
  ctx.fillStyle = '#1b1b1b'; ell(x + 18.6, y - 13.3, .8, .8);
  ctx.fillStyle = '#7a4c2a'; ell(x + 15.5, y - 14.5, 2.4, 1, -.6);
  ctx.strokeStyle = '#ead7b0'; ctx.lineWidth = 1.3; ctx.beginPath();
  for (const o of [0, 2.6]) {
    ctx.moveTo(x + 17 + o, y - 15); ctx.lineTo(x + 14 + o, y - 23);
    ctx.moveTo(x + 15.6 + o, y - 19.5); ctx.lineTo(x + 11.5 + o, y - 21);
    ctx.moveTo(x + 14.8 + o, y - 21.5); ctx.lineTo(x + 16.5 + o, y - 25);
  }
  ctx.stroke();
  ctx.strokeStyle = '#c1121f'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x + 9.5, y - 5); ctx.lineTo(x + 13.5, y - 1.5); ctx.stroke();
  ctx.fillStyle = '#ffd166'; ell(x + 12.5, y, 1.5, 1.5);
}
function drawSleigh() {
  const s = sleigh;
  T(s.dir, s.x, s.y, s.tilt * s.dir);
  ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = .28;
  blit(GOLD, -70, -70, 290, 120);
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  const pos = [64, 102, 140].map((x, i) => [x, Math.sin(s.ph * 9 + i) * 2.5 - 6]);
  ctx.strokeStyle = '#e9c46a'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(22, -10);
  for (const [x, y] of pos) ctx.lineTo(x + 11, y - 2);
  ctx.stroke();
  pos.forEach(([x, y], i) => deer(x, y, s.ph * 9 + i * .8));
  // gift sack
  ctx.fillStyle = '#7f5539'; ell(-17, -15, 9, 10);
  ctx.strokeStyle = '#2a9d8f'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-22, -22); ctx.lineTo(-12, -22); ctx.stroke();
  // Santa
  ctx.fillStyle = '#d62828'; ell(2, -15, 8, 10);
  const wave = Math.sin(s.ph * 6) * 3;
  ctx.strokeStyle = '#d62828'; ctx.lineWidth = 3.5; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(7, -18); ctx.lineTo(13, -27 + wave); ctx.stroke();
  ctx.fillStyle = '#f1f1f1'; ell(13.5, -28.5 + wave, 2, 2);
  ctx.fillStyle = '#f2c9a0'; ell(4, -28, 5, 5);
  ctx.fillStyle = '#ffffff'; ell(6, -23.5, 5.2, 5.5); ell(9, -26, 2.2, 1.6);
  ctx.fillStyle = '#d62828'; ctx.beginPath(); ctx.moveTo(-1, -30); ctx.lineTo(9.5, -31); ctx.quadraticCurveTo(4, -40, -6, -38); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#ffffff'; rr(-1.8, -32.5, 12, 3.2, 1.6); ctx.fill(); ell(-6.5, -38, 2.1, 2.1);
  ctx.fillStyle = '#1b1b1b'; ell(6.8, -28.6, .7, .7);
  // sleigh body
  const g = ctx.createLinearGradient(0, -16, 0, 2); g.addColorStop(0, '#e63946'); g.addColorStop(1, '#8d0801');
  ctx.fillStyle = g; ctx.beginPath();
  ctx.moveTo(-30, -15); ctx.lineTo(14, -12); ctx.quadraticCurveTo(24, -12, 27, -20); ctx.quadraticCurveTo(31, -20, 28, -12);
  ctx.quadraticCurveTo(25, 0, 14, 1); ctx.lineTo(-22, 1); ctx.quadraticCurveTo(-31, 0, -30, -15); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(-30, -15); ctx.lineTo(14, -12); ctx.quadraticCurveTo(24, -12, 27, -20); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-14, 1); ctx.lineTo(-14, 7); ctx.moveTo(12, 1); ctx.lineTo(12, 7);
  ctx.moveTo(-26, 7); ctx.lineTo(24, 7); ctx.quadraticCurveTo(34, 7, 32, -1); ctx.stroke();
  R0();
}

/* ---------------- excavator ---------------- */
function startExc() { const d = Math.random() < .5 ? 1 : -1; exc = { dir: d, x: d > 0 ? -120 : W + 120, y: GROUND, pile: 0, lift: 0, wheel: 0, smoke: 0, t: 0 }; }
function updExc(dt) {
  if (!exc) {
    excCool -= dt;
    if (S.excavator && S.ground && excCool < 0) { excCool = 3; let top = 0; for (const v of G) if (v > top) top = v; if (avgG() > 18 || top > 75) startExc(); }
    return;
  }
  const e = exc;
  e.t += dt; e.x += e.dir * 80 * dt; e.wheel += 80 * dt;
  const bx = e.x + e.dir * 66;
  const near = S.snowman && stacks.some(s => Math.abs(s.x - bx) < s.balls[0].r + 26);
  e.lift = lerp(e.lift, near ? 1 : 0, Math.min(1, dt * 5)); // lift the bucket over snowmen
  if (e.lift < .25) {
    const i0 = Math.max(0, Math.floor((bx - 10) / BIN)), i1 = Math.min(G.length - 1, Math.floor((bx + 10) / BIN));
    for (let i = i0; i <= i1; i++) if (G[i] > 1.2) {
      const tk = G[i] - 1.2; G[i] = 1.2; e.pile += tk;
      if (Math.random() < tk * .06) powder(bx + e.dir * 8, GROUND - 6, e.dir * 110, -rand(40, 110), true);
    }
  }
  e.y = lerp(e.y, GROUND - G[clamp((e.x / BIN) | 0, 0, G.length - 1)] * .9, Math.min(1, dt * 6));
  if ((e.smoke -= dt) < 0) { e.smoke = rand(.25, .6); add({ k: 's', x: e.x - e.dir * 27, y: e.y - 45, vx: -e.dir * rand(5, 15), vy: rand(-30, -18), r: 2.5, life: 0, max: rand(1.2, 2) }); }
  if (e.dir > 0 ? e.x > W + 170 : e.x < -170) { exc = null; excCool = 45; }
}
function drawExc() {
  const e = exc, lift = e.lift * 38, yg = ctx.createLinearGradient(0, -60, 0, -14);
  yg.addColorStop(0, '#ffd23f'); yg.addColorStop(1, '#f5a300');
  T(e.dir, e.x, e.y);
  const hg = ctx.createLinearGradient(16, 0, 130, 0); hg.addColorStop(0, 'rgba(255,236,170,.32)'); hg.addColorStop(1, 'rgba(255,236,170,0)');
  ctx.fillStyle = hg; ctx.beginPath(); ctx.moveTo(15, -48); ctx.lineTo(130, -62); ctx.lineTo(130, -2); ctx.closePath(); ctx.fill();
  // tracks
  ctx.fillStyle = '#2b2d42'; rr(-40, -14, 76, 14, 7); ctx.fill();
  ctx.strokeStyle = '#59607a'; ctx.lineWidth = 2; ctx.setLineDash([3, 3]); ctx.lineDashOffset = -e.wheel;
  rr(-38, -12.5, 72, 11, 5.5); ctx.stroke(); ctx.setLineDash([]);
  for (const wx of [-30, -15, 0, 15, 27]) {
    ctx.fillStyle = '#8d99ae'; ell(wx, -7, 3.6, 3.6);
    const a = e.wheel / 3.6; ctx.strokeStyle = '#2b2d42'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(wx - Math.cos(a) * 3, -7 - Math.sin(a) * 3); ctx.lineTo(wx + Math.cos(a) * 3, -7 + Math.sin(a) * 3); ctx.stroke();
  }
  // body + hazard stripes
  ctx.fillStyle = yg; rr(-36, -36, 58, 22, 5); ctx.fill();
  ctx.save(); rr(-36, -36, 11, 22, 5); ctx.clip(); ctx.fillStyle = '#2b2d42';
  for (let k = -2; k < 4; k++) { ctx.beginPath(); ctx.moveTo(-40 + k * 6, -14); ctx.lineTo(-34 + k * 6, -36); ctx.lineTo(-31 + k * 6, -36); ctx.lineTo(-37 + k * 6, -14); ctx.fill(); }
  ctx.restore();
  ctx.fillStyle = 'rgba(43,45,66,.2)'; ctx.fillRect(-25, -20, 47, 3);
  ctx.fillStyle = '#3d405b'; ctx.fillRect(-29, -45, 3.5, 9);
  // cab, window, driver in a Santa hat
  ctx.fillStyle = yg; rr(-14, -60, 27, 25, 4); ctx.fill();
  const wg = ctx.createLinearGradient(0, -56, 0, -42); wg.addColorStop(0, '#d7ecff'); wg.addColorStop(1, '#86b6e8');
  ctx.fillStyle = wg; rr(-10, -56, 19, 14, 2); ctx.fill();
  ctx.fillStyle = '#f2c9a0'; ell(-1, -46, 3.2, 3.2);
  ctx.fillStyle = '#d62828'; ctx.beginPath(); ctx.moveTo(-4.6, -48); ctx.lineTo(2.6, -48.5); ctx.quadraticCurveTo(0, -55, -6, -54.3); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.fillRect(-4.8, -49.3, 7.6, 1.8); ell(-6, -54.3, 1.4, 1.4);
  ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(4, -55); ctx.lineTo(7.5, -50.5); ctx.stroke();
  // beacon
  ctx.fillStyle = '#555'; ctx.fillRect(-3, -62, 6, 2.5);
  ctx.fillStyle = '#ff8c1a'; ctx.beginPath(); ctx.arc(0, -62, 3, Math.PI, 0); ctx.fill();
  ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = (.5 + .5 * Math.sin(e.t * 9)) * .85;
  blit(WARM, -15, -77, 30, 30);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#fff6c9'; ell(14, -48, 1.8, 1.8);
  // boom, stick, bucket
  const ex = 40, ey = -60, bxl = 64, byl = -10 - lift;
  ctx.lineCap = 'round'; ctx.strokeStyle = '#f5a300'; ctx.lineWidth = 7;
  ctx.beginPath(); ctx.moveTo(14, -30); ctx.lineTo(ex, ey); ctx.lineTo(bxl, byl - 6); ctx.stroke();
  ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 2.2;
  ctx.beginPath(); ctx.moveTo(14, -32); ctx.lineTo(ex, ey - 2); ctx.lineTo(bxl, byl - 8); ctx.stroke();
  ctx.strokeStyle = '#adb5bd'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(10, -24); ctx.lineTo(30, -50); ctx.stroke();
  ctx.fillStyle = '#495057'; for (const [jx, jy] of [[14, -30], [ex, ey], [bxl, byl - 6]]) ell(jx, jy, 2.4, 2.4);
  for (let k = 0; k < 4; k++) { // tiny fairy lights on the boom
    const u = (k + .5) / 4, gx = lerp(14, ex, u), gy = lerp(-30, ey, u) + 5, b = .5 + .5 * Math.sin(e.t * 5 + k * 1.7);
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = b * .9; blit(GLOWS[k], gx - 7, gy - 7, 14, 14);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = COLORS[k]; ell(gx, gy, 1.5, 1.5);
  }
  ctx.fillStyle = '#5c636a'; ctx.strokeStyle = '#343a40'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(bxl - 7, byl - 8); ctx.quadraticCurveTo(bxl - 9, byl + 9, bxl + 3, byl + 10);
  ctx.lineTo(bxl + 12, byl + 10); ctx.lineTo(bxl + 8, byl - 4); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#343a40';
  for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.moveTo(bxl + 3 + k * 3, byl + 10); ctx.lineTo(bxl + 5.5 + k * 3, byl + 12.5); ctx.lineTo(bxl + 6 + k * 3, byl + 10); ctx.fill(); }
  R0();
}
function drawPile() {
  const e = exc, hh = Math.min(46, Math.sqrt(e.pile * BIN / 1.9));
  if (hh < 2) return;
  const w = Math.max(10, hh * 2.3), base = -e.lift * 38, px = 76 + w * .45;
  T(e.dir, e.x, e.y);
  ctx.beginPath(); ctx.moveTo(px - w / 2, base);
  for (let a = 0; a <= 10; a++) {
    const u = a / 10, ang = Math.PI * (1 - u), bump = 1 + Math.sin(u * 17 + 1) * .06;
    ctx.lineTo(px + Math.cos(ang) * w / 2 * bump, base - Math.sin(ang) * hh * bump);
  }
  ctx.closePath();
  const g = ctx.createLinearGradient(0, base - hh, 0, base); g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#d3def3');
  ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = 'rgba(150,175,220,.55)'; ctx.lineWidth = .7; ctx.stroke();
  R0();
}

/* ---------------- snowballs & snowmen ---------------- */
function mkStack(x, radii) {
  return { x, y: groundTop(x), vy: 0, balls: radii.map(r => ({ r, rot: rand(0, TAU) })), decor: 0, blink: rand(2, 5), bl: 0, wave: 0, waveT: rand(6, 14), pop: 0 };
}
const isMan = s => s.balls.length === 3;
// at most MAX_STACKS snowmen and MAX_STACKS loose balls/piles; the oldest one melts away in a puff
function addStack(s) { stacks.push(s); trimStacks(); }
function trimStacks() {
  for (const kind of [true, false]) {
    const same = stacks.filter(q => isMan(q) === kind);
    while (same.length > MAX_STACKS) poof(same.shift());
  }
}
function poof(s) {
  const c = centers(s);
  s.balls.forEach((b, k) => { for (let q = 0; q < b.r; q++) powder(s.x + rand(-b.r, b.r), c[k] + rand(-b.r, b.r), rand(-60, 60), -rand(30, 140), true); });
  const i = stacks.indexOf(s); if (i >= 0) stacks.splice(i, 1);
  if (dragStack === s) dragStack = null;
}
function freeX() {
  for (let k = 0; k < 30; k++) {
    const x = rand(90, W - 90);
    if (stacks.every(s => Math.abs(s.x - x) > 110) && !(exc && Math.abs(exc.x - x) < 200)) return x;
  }
  return null;
}
function centers(s) {
  const c = []; let cy = s.y - s.balls[0].r * .85; c.push(cy);
  for (let k = 1; k < s.balls.length; k++) { cy -= (s.balls[k - 1].r + s.balls[k].r) * .78; c.push(cy); }
  return c;
}
function pick() {
  for (let j = stacks.length - 1; j >= 0; j--) {
    const s = stacks[j], c = centers(s);
    for (let k = s.balls.length - 1; k >= 0; k--) { const dx = mx - s.x, dy = my - c[k], r = s.balls[k].r + 4; if (dx * dx + dy * dy < r * r) return { s, k }; }
  }
  return null;
}
addEventListener('mousemove', e => { mx = e.clientX; my = e.clientY; });
addEventListener('mousedown', e => {
  if (e.button !== 0 || !S?.snowman) return;
  const p = pick(); if (!p) return;
  const { s, k } = p;
  if (k === s.balls.length - 1) { // take the top ball off
    const b = s.balls.pop();
    held = { r: b.r, rot: b.rot, x: s.x, y: centers({ ...s, balls: [...s.balls, b] })[k] };
    if (!s.balls.length) stacks.splice(stacks.indexOf(s), 1);
  } else { dragStack = s; dragOff = s.x - mx; }
});
// right-click a snowman or a ball → it melts away
addEventListener('contextmenu', e => { e.preventDefault(); const p = S?.snowman && pick(); if (p) poof(p.s); });
addEventListener('mouseup', () => {
  if (held) {
    const tgt = stacks.find(s => {
      if (s.balls.length >= 3) return false;
      const c = centers(s), top = s.balls[s.balls.length - 1];
      return Math.abs(held.x - s.x) < top.r + held.r * .5 && held.y < c[c.length - 1] + top.r && held.r <= top.r * 1.15;
    });
    if (tgt) {
      tgt.balls.push({ r: held.r, rot: held.rot });
      if (tgt.balls.length === 3) {
        stacks.splice(stacks.indexOf(tgt), 1); addStack(tgt); // newest snowman survives the cap
        const c = centers(tgt); for (let q = 0; q < 26; q++) add({ k: 'g', x: tgt.x + rand(-30, 30), y: c[2] + rand(-30, 20), vx: rand(-40, 40), vy: rand(-60, 0), r: rand(.8, 2), life: 0, max: rand(1, 2), c: (Math.random() * 4) | 0, ph: rand(0, TAU) }); }
    } else { const s = mkStack(held.x, [held.r]); s.balls[0].rot = held.rot; s.y = held.y + held.r * .85; s.pop = 1; addStack(s); }
    held = null;
  }
  dragStack = null;
});
function updPointer(dt) {
  if (pmx !== null) { mvx = lerp(mvx, clamp((mx - pmx) / dt, -4000, 4000), .35); mvy = lerp(mvy, clamp((my - pmy) / dt, -4000, 4000), .35); }
  pmx = mx; pmy = my;
  const p = S.snowman && !held && !dragStack ? pick() : null;
  if (p && p.s.balls.length === 3 && !p.s.wave) p.s.wave = 1.2;
  const want = !!(held || dragStack || p);
  if (want !== capture) { capture = want; api.send('capture', want); }
  const cur = held || dragStack ? 'grabbing' : p ? 'grab' : '';
  if (cur !== cursor) document.body.style.cursor = cursor = cur;
}
function updStacks(dt) {
  if ((ballT -= dt) < 0) { // a little snowball forms by itself now and then
    ballT = rand(30, 70);
    if (S.ground && stacks.filter(s => !isMan(s)).length < 2 && avgG() > 10) { const x = freeX(); if (x != null) addStack(mkStack(x, [rand(7, 10)])); }
  }
  for (const s of stacks) {
    if (s === dragStack) s.x = clamp(mx + dragOff, 20, W - 20);
    const gy = groundTop(s.x);
    if (s.y < gy - 1) { s.vy += 1100 * dt; s.y = Math.min(gy, s.y + s.vy * dt); if (s.y >= gy) { if (s.vy > 250) for (let q = 0; q < 8; q++) powder(s.x, gy - 2, rand(-70, 70), -rand(30, 120), true); s.vy = 0; } }
    else s.y += (gy - s.y) * Math.min(1, dt * 3);
    s.pop = Math.min(1, s.pop + dt * 2.5);
    s.decor = s.balls.length === 3 ? Math.min(1, s.decor + dt * 1.8) : 0;
    if ((s.blink -= dt) < 0) { s.blink = rand(2.5, 6); s.bl = .14; }
    s.bl = Math.max(0, s.bl - dt);
    if ((s.waveT -= dt) < 0) { s.waveT = rand(9, 18); s.wave = 1.6; }
    s.wave = Math.max(0, s.wave - dt);
  }
  if (held) {
    const gy = groundTop(held.x), rolling = my > gy - held.r * 2.2, k = Math.min(1, dt * 14);
    const dx = (mx - held.x) * k;
    held.x += dx; held.y += ((rolling ? gy - held.r * .85 : my) - held.y) * k; held.rot += dx / held.r;
    if (rolling && S.ground && Math.abs(dx) > .2) { // rolling picks up snow and leaves a groove
      let got = 0;
      const i0 = Math.max(0, Math.floor((held.x - held.r * .7) / BIN)), i1 = Math.min(G.length - 1, Math.floor((held.x + held.r * .7) / BIN));
      for (let i = i0; i <= i1; i++) { const tk = Math.min(G[i], Math.abs(dx) * .15); G[i] -= tk; got += tk; }
      held.r = Math.min(46, Math.sqrt(held.r * held.r + got * BIN * .5));
    }
  }
}
function drawBall(x, y, r, rot) {
  const g = ctx.createRadialGradient(x - r * .35, y - r * .4, r * .1, x, y, r);
  g.addColorStop(0, '#ffffff'); g.addColorStop(.65, '#eef3fc'); g.addColorStop(1, '#c6d4ee');
  ctx.fillStyle = g; ell(x, y, r, r);
  ctx.strokeStyle = 'rgba(110,135,185,.45)'; ctx.lineWidth = .8; ctx.stroke();
  ctx.fillStyle = 'rgba(160,182,222,.55)';
  for (let j = 0; j < 5; j++) { const a = rot + j * 1.26, q = r * (.3 + (j % 3) * .2); ell(x + Math.cos(a) * q, y + Math.sin(a) * q * .9, Math.max(.6, r * .05), Math.max(.6, r * .05)); }
}
function drawStack(s) {
  const c = centers(s), sc = easeBack(s.pop);
  ctx.fillStyle = 'rgba(50,70,120,.18)'; ell(s.x, s.y + 1, s.balls[0].r * 1.05 * sc, 3);
  s.balls.forEach((b, k) => drawBall(s.x, s.y - (s.y - c[k]) * sc, b.r * sc, b.rot));
  if (s.balls.length === 3 && s.decor > 0) drawDecor(s, c, easeBack(s.decor));
}
function drawDecor(s, c, e) {
  const x = s.x, r1 = s.balls[1].r, r2 = s.balls[2].r, y1 = c[1], y2 = c[2];
  const lx = clamp((mx - x) / 300, -1, 1), ly = clamp((my - y2) / 300, -1, 1);
  // twig arms, the right one waves
  ctx.strokeStyle = '#6b4226'; ctx.lineCap = 'round'; ctx.lineWidth = Math.max(1.4, r1 * .08);
  const arm = (side, ang) => {
    const sx = x + side * r1 * .8, sy = y1 - r1 * .25, L = r1 * 1.15 * e, ca = Math.cos(ang), sa = Math.sin(ang);
    const ex = sx + side * ca * L, ey = sy - sa * L, fx = sx + side * ca * L * .65, fy = sy - sa * L * .65;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey);
    ctx.moveTo(fx, fy); ctx.lineTo(fx + side * Math.cos(ang + .8) * L * .3, fy - Math.sin(ang + .8) * L * .3);
    ctx.moveTo(ex, ey); ctx.lineTo(ex + side * Math.cos(ang - .6) * L * .22, ey - Math.sin(ang - .6) * L * .22);
    ctx.stroke();
  };
  arm(-1, .45);
  arm(1, s.wave > 0 ? .95 + Math.sin(t * 14) * .45 : .35);
  ctx.fillStyle = '#23232b';
  for (let k = -1; k <= 1; k++) ell(x, y1 + k * r1 * .33, r1 * .075 * e, r1 * .075 * e);
  // scarf
  const ny = y2 + r2 * .82, fl = Math.sin(t * 3 + s.x) * 2 + wind * .03;
  ctx.fillStyle = '#d62839';
  rr(x - r2 * .9, ny - r2 * .2, r2 * 1.8, r2 * .38, r2 * .18); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x + r2 * .25, ny); ctx.lineTo(x + r2 * .62, ny);
  ctx.lineTo(x + r2 * .78 + fl, ny + r2 * 1.05 * e); ctx.lineTo(x + r2 * .42 + fl, ny + r2 * 1.1 * e); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = Math.max(1, r2 * .07); ctx.beginPath();
  for (const u of [-.5, 0, .5]) { ctx.moveTo(x + u * r2 - r2 * .06, ny - r2 * .17); ctx.lineTo(x + u * r2 + r2 * .06, ny + r2 * .15); }
  ctx.stroke();
  // face: eyes follow the cursor
  ctx.fillStyle = '#1d1d24';
  for (const sd of [-1, 1]) ell(x + sd * r2 * .32 + lx * r2 * .1, y2 - r2 * .15 + ly * r2 * .08, r2 * .1 * e, r2 * .1 * e * (s.bl > 0 ? .15 : 1));
  for (let k = -2; k <= 2; k++) ell(x + k * r2 * .14 + lx * r2 * .06, y2 + r2 * .45 - k * k * r2 * .03, r2 * .045 * e, r2 * .045 * e);
  const nd = lx >= 0 ? 1 : -1, nx = x + lx * r2 * .1;
  ctx.fillStyle = '#f77f00'; ctx.beginPath(); ctx.moveTo(nx, y2 + r2 * .02); ctx.lineTo(nx + nd * r2 * .7 * e, y2 + r2 * .12); ctx.lineTo(nx, y2 + r2 * .2); ctx.closePath(); ctx.fill();
  // red beanie with a pompom
  const hy = y2 - r2 * .45, sw = Math.sin(t * 2 + s.x) * r2 * .08 + wind * .02;
  ctx.fillStyle = '#c81d25'; ctx.beginPath(); ctx.moveTo(x - r2 * .82, hy);
  ctx.quadraticCurveTo(x - r2 * .7, hy - r2 * 1.05 * e, x + r2 * .3 + sw, hy - r2 * e);
  ctx.quadraticCurveTo(x + r2 * .75, hy - r2 * .6 * e, x + r2 * .82, hy); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#f8f9fa'; rr(x - r2 * .9, hy - r2 * .12, r2 * 1.8, r2 * .32, r2 * .16); ctx.fill();
  ell(x + r2 * .3 + sw, hy - r2 * 1.02 * e, r2 * .2 * e, r2 * .2 * e);
}

/* ---------------- loop ---------------- */
function frame(now) {
  if (!active || !S) { raf = 0; return; }
  raf = requestAnimationFrame(frame);
  if (now - last < 1000 / FPS - 2) return;
  const dt = Math.min(.05, (now - last) / 1000 || .016);
  last = now; t += dt; frameN++;
  updWind(); updPointer(dt); updFlakes(dt); updSurfaces(dt);
  if (S.snowman) updStacks(dt);
  updExc(dt); updSleigh(dt); updParts(dt); updSparks(dt); updGarland(dt);
  if (!capture && Math.hypot(mvx, mvy) > 25) {
    if (S.ground) brushDrift(G, 0, GROUND, -1);
    for (const o of order) brushDrift(o.d, o.x, o.y, o.z);
  }
  draw();
}
function draw() {
  R0(); ctx.clearRect(0, 0, W, H);
  for (let k = order.length - 1; k >= 0; k--) { // back to front; each window hides the drifts behind it
    const o = order[k];
    ctx.clearRect(o.x, o.y, o.w, o.h);
    if (o.y > 4) { drawDrift(o.d, o.x, o.y); drawIce(o); }
  }
  if (sleigh) drawSleigh();
  if (S.snowman) for (const s of stacks) drawStack(s);
  if (exc) drawExc();
  drawDrift(G, 0, GROUND);
  if (exc) drawPile();
  if (held) drawBall(held.x, held.y, held.r, held.rot);
  drawSparks(); drawParts(); drawFlakes(); drawGlitter(); drawGarland();
}
