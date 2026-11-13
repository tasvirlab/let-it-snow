'use strict';
const { app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path'), fs = require('fs');
const { dict, resolve } = require('./i18n');

if (!app.requestSingleInstanceLock()) app.quit();

const DEFAULTS = {
  paused: false, weatherMode: 'manual', city: '',
  intensity: 55, wind: 15, gusts: true, size: 50, opacity: 90,
  ground: true, windows: true, melt: false, icicles: true,
  garland: true, sleigh: true, excavator: true, snowman: true,
  hideInCapture: false, launchAtLogin: false, seen: false, lang: 'auto',
};
const PRESETS = [
  { id: 'calm', v: { intensity: 22, wind: 0, gusts: false, size: 75 } },
  { id: 'light', v: { intensity: 40, wind: 10, gusts: true, size: 50 } },
  { id: 'snow', v: { intensity: 65, wind: 20, gusts: true, size: 50 } },
  { id: 'storm', v: { intensity: 100, wind: 75, gusts: true, size: 40 } },
];
const SNOW = { 71: 35, 73: 60, 75: 90, 77: 25, 85: 50, 86: 85 };

let S, live = null, tray = null, settingsWin = null, weatherTimer = null, saveTimer = null, fullId = null;
const overlays = [];
const file = () => path.join(app.getPath('userData'), 'settings.json');
const load = () => {
  // first run after a rename (Oppoq → New Year → Let It Snow): pick up the old settings once
  const old = n => path.join(app.getPath('appData'), n, 'settings.json');
  for (const f of [file(), old('New Year'), old('Oppoq')]) { try { S = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(f, 'utf8')) }; return; } catch {} }
  S = { ...DEFAULTS };
};
const lang = () => resolve(S.lang, app);
const T = () => dict[lang()];
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => fs.writeFile(file(), JSON.stringify(S, null, 1), () => {}), 300); };
const alive = () => overlays.filter(o => !o.isDestroyed());
// small diagnostics file (userData/debug.log) so window tracking can be checked on machines we can't test on
const dbg = msg => fs.appendFile(path.join(app.getPath('userData'), 'debug.log'), `${new Date().toISOString()} ${msg}
`, () => {});
let pollN = 0, listError = '';

function effective() {
  const e = { ...S };
  if (S.weatherMode === 'real' && live?.intensity != null) { e.intensity = live.intensity; e.wind = live.wind; }
  return e;
}
const state = () => ({ settings: S, live, presets: PRESETS, t: T(), lang: lang() });
function push() {
  const e = effective();
  for (const o of alive()) o.webContents.send('settings', e);
  settingsWin?.webContents.send('state', state());
  updateVisibility();
  tray?.setContextMenu(menu());
}
function set(patch) {
  patch = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => k in DEFAULTS));
  const weather = 'city' in patch || ('weatherMode' in patch && patch.weatherMode !== S.weatherMode);
  Object.assign(S, patch); save();
  if ('launchAtLogin' in patch) app.setLoginItemSettings({ openAtLogin: S.launchAtLogin });
  if ('lang' in patch) { settingsWin?.setTitle(T().app); tray?.setToolTip(T().tooltip); }
  if ('hideInCapture' in patch) alive().forEach(o => o.setContentProtection(S.hideInCapture));
  weather ? refreshWeather() : push();
}

/* ---------- real weather (Open-Meteo, no key) ---------- */
async function refreshWeather() {
  clearTimeout(weatherTimer);
  if (S.weatherMode !== 'real' || !S.city.trim()) { live = null; return push(); }
  live = { loading: true }; push();
  try {
    const g = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=${lang()}&name=${encodeURIComponent(S.city.trim())}`)).json();
    const p = g.results?.[0];
    if (!p) throw new Error('cityNotFound');
    const c = (await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}` +
      '&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,snowfall')).json()).current;
    live = { place: [p.name, p.country].filter(Boolean).join(', '), ...mapWeather(c) };
  } catch (e) {
    live = { error: e.message === 'cityNotFound' ? 'cityNotFound' : 'noInternet' }; // keys into i18n
  }
  weatherTimer = setTimeout(refreshWeather, 15 * 60e3);
  push();
}
function mapWeather(c) {
  const code = c.weather_code, snowing = code in SNOW;
  const dir = c.wind_direction_10m * Math.PI / 180; // where the wind comes FROM
  return {
    snowing, temp: Math.round(c.temperature_2m), speed: Math.round(c.wind_speed_10m),
    desc: code in dict.en.codes ? code : code >= 80 ? 'showers' : code >= 51 ? 'rain' : 'other', // key into i18n codes
    // ponytail: no real snow outside → still a gentle festive flurry, it's the app's whole point
    intensity: snowing ? Math.max(SNOW[code], Math.min(100, Math.round(c.snowfall * 60))) : 18,
    wind: Math.round(Math.max(-100, Math.min(100, -Math.sin(dir) * c.wind_speed_10m * 2.5))),
  };
}

/* ---------- overlays: one transparent click-through window per display ---------- */
function makeOverlays() {
  while (overlays.length) { const o = overlays.pop(); if (!o.isDestroyed()) o.destroy(); }
  for (const d of screen.getAllDisplays()) {
    const w = new BrowserWindow({
      ...d.bounds, transparent: true, frame: false, resizable: false, movable: false, focusable: false,
      skipTaskbar: true, hasShadow: false, fullscreenable: false, show: false, backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    w.setIgnoreMouseEvents(true, { forward: true });
    w.setContentProtection(S.hideInCapture);
    Object.assign(w, { display: d, shown: false, lastWins: '' });
    w.handle = process.platform === 'win32' ? w.getNativeWindowHandle().readBigUInt64LE(0) : 0n;
    w.webContents.on('did-finish-load', () => {
      const b = d.bounds, a = d.workArea;
      w.setBounds(b);
      // macOS: the Dock floats, so snow settles on the real screen edge (low, so it never buries the Dock icons);
      // Windows: it sits on top of the taskbar
      const mac = process.platform === 'darwin';
      w.webContents.send('geo', { w: b.width, h: b.height, ground: mac ? b.height : a.y + a.height - b.y, top: a.y - b.y, gmax: mac ? 16 : 110, mac });
      w.webContents.send('settings', effective());
      w.lastWins = ''; // anything polled before the page loaded was lost; resend
      updateVisibility();
      w.webContents.send('active', w.shown);
    });
    w.webContents.on('console-message', (e, ...a) => console.log('[overlay]', e.message ?? a[1]));
    w.loadFile('overlay.html');
    overlays.push(w);
  }
}
function updateVisibility() {
  for (const o of alive()) {
    const on = !S.paused && o.display.id !== fullId;
    if (on === o.shown) continue;
    o.shown = on;
    if (on) { o.showInactive(); o.setAlwaysOnTop(true, 'screen-saver'); } else o.hide();
    o.webContents.send('active', on);
  }
}
const watch = require('./winwatch');
function poll() {
  const skip = new Set(alive().map(o => o.handle));
  const f = watch.fullscreen(skip);
  if (f !== fullId) { fullId = f; updateVisibility(); }
  let list = [];
  try { list = watch.list(skip); } catch (e) { if (e.message !== listError) dbg('window list failed: ' + (listError = e.message)); }
  if (pollN++ % 300 === 0 && pollN < 2000) dbg(`windows: ${list.length} ${JSON.stringify(list.slice(0, 4))}`);
  for (const o of alive()) {
    if (!o.shown) continue;
    const b = o.display.bounds;
    const wins = list
      // >8px overlap: maximized windows spill a few px onto the neighbouring monitor
      .filter(r => r.x + 8 < b.x + b.width && r.x + r.w > b.x + 8 && r.y + 8 < b.y + b.height && r.y + r.h > b.y + 8)
      .map(r => ({ id: r.id, x: r.x - b.x, y: r.y - b.y, w: r.w, h: r.h }));
    const key = JSON.stringify(wins);
    if (key !== o.lastWins) { o.lastWins = key; o.webContents.send('wins', wins); }
  }
}

/* ---------- tray + settings ---------- */
function cmd(c) {
  const here = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
  for (const o of alive()) if (c === 'clear' || o.display.id === here) o.webContents.send('cmd', c);
}
function menu() {
  const t = T(), preset = p => S.weatherMode === 'manual' && Object.entries(p.v).every(([k, v]) => S[k] === v);
  return Menu.buildFromTemplate([
    { label: S.paused ? t.resume : t.pause, click: () => set({ paused: !S.paused }) },
    { label: t.weather, submenu: PRESETS.map(p => ({ label: t['p_' + p.id], type: 'radio', checked: preset(p), click: () => set({ ...p.v, weatherMode: 'manual' }) })) },
    { type: 'separator' },
    { label: t.snowmanMenu, click: () => cmd('snowman') },
    { label: t.actSleigh, click: () => cmd('sleigh') },
    { label: t.actExcavator, click: () => cmd('excavator') },
    { label: t.actClear, click: () => cmd('clear') },
    { type: 'separator' },
    { label: t.settings, click: openSettings },
    { label: t.quit, click: () => app.quit() },
  ]);
}
function openSettings() {
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 440, height: 780, resizable: false, maximizable: false, fullscreenable: false, show: false,
    title: T().app, icon: path.join(__dirname, 'assets', 'icon.png'), backgroundColor: '#1a2058', autoHideMenuBar: true,
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#1a2058', symbolColor: '#c9d0ff', height: 40 },
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  settingsWin.loadFile('settings.html');
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => (settingsWin = null));
}

ipcMain.handle('get', state);
ipcMain.on('set', (_e, p) => set(p));
ipcMain.on('cmd', (_e, c) => cmd(c));
ipcMain.on('capture', (e, on) => BrowserWindow.fromWebContents(e.sender)?.setIgnoreMouseEvents(!on, { forward: true }));
function makeTray() {
  const face = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')), img = nativeImage.createEmpty();
  for (const s of [1, 1.25, 1.5, 2]) img.addRepresentation({ scaleFactor: s, buffer: face.resize({ width: Math.round(16 * s), quality: 'best' }).toPNG() });
  tray = new Tray(img);
  tray.setToolTip(T().tooltip);
  tray.setContextMenu(menu());
  tray.on('click', openSettings);
}

app.whenReady().then(() => {
  load();
  app.dock?.hide();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: S.launchAtLogin }); // keep the entry pointing at the installed exe
  else app.setLoginItemSettings = () => {}; // dev runs (npm start) never register bare electron.exe at login
  fs.writeFile(path.join(app.getPath('userData'), 'debug.log'), '', () =>
    dbg(`v${app.getVersion()} ${process.platform} ${process.arch} tracking=${watch.error || 'ok'} displays=${JSON.stringify(screen.getAllDisplays().map(d => [d.bounds, d.workArea]))}`));
  makeTray();
  makeOverlays();
  let t;
  const rebuild = () => { clearTimeout(t); t = setTimeout(makeOverlays, 600); };
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, rebuild);
  setInterval(poll, 33);
  refreshWeather();
  if (!S.seen) { openSettings(); set({ seen: true }); }});
app.on('second-instance', openSettings);
app.on('window-all-closed', () => {}); // live in the tray
