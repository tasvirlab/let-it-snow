'use strict';
// macOS only: where is the Dock? → { x, y, w, h, src } in global DIP coordinates (top-left origin, same as Electron),
// or { none: 'autohide' | 'side' | 'hidden' }.
// 1) Accessibility API on the Dock process: its AXList child is exactly the Dock bar. Needs the Accessibility permission.
// 2) Without that permission: an estimate from the Dock preferences and the running apps
//    (a bottom Dock is centred, and every tile / divider has a fixed pitch for a given tile size).
const { execFile, execFileSync } = require('child_process');
const { screen, systemPreferences } = require('electron');

let ax = null, axFail = '', dockPid = 0;
const GLASS = +require('os').release().split('.')[0] >= 25; // Darwin 25 = macOS 26 (Liquid Glass Dock)
function axInit() {
  const koffi = require('koffi');
  const lib = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const P = koffi.struct('AXDockPoint', { x: 'double', y: 'double' }), Z = koffi.struct('AXDockSize', { w: 'double', h: 'double' });
  const f = {
    app: lib.func('void *AXUIElementCreateApplication(int pid)'),
    copy: lib.func('int AXUIElementCopyAttributeValue(void *el, void *attr, _Out_ void **val)'),
    pt: lib.func('AXValueGetValue', 'bool', ['void *', 'int', koffi.out(koffi.pointer(P))]),
    sz: lib.func('AXValueGetValue', 'bool', ['void *', 'int', koffi.out(koffi.pointer(Z))]),
    count: cf.func('long CFArrayGetCount(void *a)'),
    at: cf.func('void *CFArrayGetValueAtIndex(void *a, long i)'),
    cstr: cf.func('bool CFStringGetCString(void *s, _Out_ uint8_t *buf, long n, uint32 enc)'),
    str: cf.func('void *CFStringCreateWithCString(void *alloc, const char *s, uint32 enc)'),
    rel: cf.func('void CFRelease(void *p)'),
  };
  const K = s => f.str(null, s, 0x08000100);
  return { ...f, kids: K('AXChildren'), role: K('AXRole'), pos: K('AXPosition'), size: K('AXSize'), buf: Buffer.alloc(64), out: [null] };
}
function pidOfDock() {
  try { return +execFileSync('/usr/bin/pgrep', ['-x', 'Dock'], { encoding: 'utf8' }).split('\n')[0] || 0; } catch { return 0; }
}
// the Dock's AXList frame, or null (error code in axFail)
function axRect() {
  if (!ax) ax = axInit();
  if (!dockPid) dockPid = pidOfDock();
  const a = ax, out = a.out, app = dockPid && a.app(dockPid);
  if (!app) { axFail = 'no Dock process'; return null; }
  try {
    const e = a.copy(app, a.kids, out);
    if (e) { axFail = 'AXError ' + e; if (e === -25204 || e === -25202) dockPid = 0; return null; } // Dock restarted → new pid next time
    const kids = out[0];
    try {
      for (let i = 0, n = a.count(kids); i < n; i++) {
        const el = a.at(kids, i);
        if (a.copy(el, a.role, out)) continue;
        a.buf.fill(0); a.cstr(out[0], a.buf, 64, 0x08000100); a.rel(out[0]);
        if (a.buf.toString('utf8', 0, a.buf.indexOf(0)) !== 'AXList') continue;
        const p = {}, s = {};
        if (a.copy(el, a.pos, out)) break; a.pt(out[0], 1 /* CGPoint */, p); a.rel(out[0]);
        if (a.copy(el, a.size, out)) break; a.sz(out[0], 2 /* CGSize */, s); a.rel(out[0]);
        axFail = '';
        return { x: p.x, y: p.y, w: s.w, h: s.h };
      }
    } finally { a.rel(kids); }
  } finally { a.rel(app); }
  axFail = 'no AXList';
  return null;
}

const run = (cmd, args) => new Promise(res => execFile(cmd, args, { encoding: 'utf8', timeout: 4000 }, (e, out) => res(e ? '' : out)));
// top-level keys of `defaults export com.apple.dock -` → raw XML of each value
function prefs(xml) {
  const p = {}, re = /\n\t<key>([^<]+)<\/key>\n\t([\s\S]*?)(?=\n\t<key>|\n<\/dict>)/g;
  for (let m; (m = re.exec(xml));) p[m[1]] = m[2];
  return p;
}
const ids = v => [...(v || '').matchAll(/<key>bundle-identifier<\/key>\s*<string>([^<]+)<\/string>/g)].map(m => m[1]);
const tiles = v => ((v || '').match(/<key>tile-data<\/key>/g) || []).length;
const num = (v, d) => { const m = /<(?:real|integer)>([\d.]+)</.exec(v || ''); return m ? +m[1] : d; };
const SELF = new Set(['uz.letitsnow.app', 'com.github.Electron', 'com.apple.finder']);

// Measured on macOS 26/27 at tile size 58: tile pitch = size + 4, a divider adds 27.5, the bar adds 7 at each end;
// the bar is size + 18 tall and floats 6 above the screen edge.
async function estimate(p, disp) {
  const size = num(p.tilesize, 48), apps = ids(p['persistent-apps']);
  const running = (await run('/usr/bin/lsappinfo', ['list'])).split(/\n\s*\d+\) "/)
    .filter(b => b.includes('type="Foreground"')).map(b => (/bundleID="([^"]+)"/.exec(b) || [])[1]).filter(Boolean);
  const mid = new Set(running.filter(id => !SELF.has(id) && !apps.includes(id)));
  if (!/<false\/>/.test(p['show-recents'] || '')) for (const id of ids(p['recent-apps'])) if (!apps.includes(id)) mid.add(id);
  const n = 1 + apps.length + mid.size + tiles(p['persistent-others']) + 1; // Finder … Trash
  const w = Math.round(n * (size + 4) + (mid.size ? 2 : 1) * 27.5 + 14), h = size + 18;
  const b = disp.bounds, a = disp.workArea;
  const bottom = a.y + a.height < b.y + b.height - 10 ? a.y + a.height + 2 + h : b.y + b.height - 6; // workArea already leaves room for it
  return { x: Math.round(b.x + (b.width - w) / 2), y: bottom - h, w, h, src: 'estimate' };
}

async function get() {
  const p = prefs(await run('/usr/bin/defaults', ['export', 'com.apple.dock', '-']));
  if (/<true\/>/.test(p.autohide || '')) return { none: 'autohide' };
  if (/<string>(left|right)<\/string>/.test(p.orientation || '')) return { none: 'side' };
  if (systemPreferences.isTrustedAccessibilityClient(false)) {
    let r = null;
    try { r = axRect(); } catch (e) { axFail = e.message; }
    if (r && r.w > 0) {
      if (r.h > r.w) return { none: 'side' };
      const d = screen.getDisplayMatching({ x: r.x, y: r.y, width: r.w, height: r.h }).bounds;
      if (r.y >= d.y + d.height - 4) return { none: 'hidden' }; // slid off the bottom edge
      // macOS 26+ draws the glass bar ~5 pt below its accessibility frame (measured on a real screen); older Docks match it
      const dy = GLASS ? 5 : 0;
      return { x: Math.round(r.x), y: Math.round(r.y) + dy, w: Math.round(r.w), h: Math.round(r.h), src: 'ax' };
    }
  } else axFail = 'not trusted';
  return estimate(p, screen.getPrimaryDisplay());
}
module.exports = { get, axStatus: () => axFail };
