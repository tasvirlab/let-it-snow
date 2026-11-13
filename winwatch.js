// Lists visible top-level windows (front to back) in Electron screen coordinates (DIP).
// Windows: user32/dwmapi via koffi. macOS: CoreGraphics window list. Elsewhere: none (snow settles on the ground only).
const { screen } = require('electron');

let impl = { list: () => [], fullscreen: () => null };
try {
  if (process.platform === 'win32') impl = win();
  else if (process.platform === 'darwin') impl = mac();
} catch (e) {
  impl.error = e.message;
  console.error('window tracking off:', e.message);
}
module.exports = impl;

function win() {
  const koffi = require('koffi');
  const u = koffi.load('user32.dll'), dwm = koffi.load('dwmapi.dll');
  const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  const EnumProc = koffi.proto('bool __stdcall EnumProc(void *h, intptr_t l)');
  const EnumWindows = u.func('bool __stdcall EnumWindows(EnumProc *cb, intptr_t l)');
  const IsWindowVisible = u.func('bool __stdcall IsWindowVisible(void *h)');
  const IsIconic = u.func('bool __stdcall IsIconic(void *h)');
  const GetWindowLongW = u.func('int32 __stdcall GetWindowLongW(void *h, int i)');
  const GetWindowTextLengthW = u.func('int __stdcall GetWindowTextLengthW(void *h)');
  const GetClassNameW = u.func('int __stdcall GetClassNameW(void *h, void *buf, int n)');
  const GetForegroundWindow = u.func('void * __stdcall GetForegroundWindow()');
  const GetWindowRect = u.func('bool __stdcall GetWindowRect(void *h, _Out_ RECT *r)');
  const DwmRect = dwm.func('__stdcall', 'DwmGetWindowAttribute', 'int32', ['void *', 'uint32', koffi.out(koffi.pointer(RECT)), 'uint32']);
  const DwmInt = dwm.func('__stdcall', 'DwmGetWindowAttribute', 'int32', ['void *', 'uint32', koffi.out(koffi.pointer('int32')), 'uint32']);

  const SKIP = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Windows.UI.Core.CoreWindow',
    'NotifyIconOverflowWindow', 'TopLevelWindowForOverflowXamlIsland', 'XamlExplorerHostIslandWindow']);
  const buf = Buffer.alloc(512), cloaked = [0], r = {};
  const classes = new Map(); // hwnd → class name (never changes for a live window)
  const className = h => buf.toString('utf16le', 0, GetClassNameW(h, buf, 256) * 2);
  const rectOf = h => {
    if (DwmRect(h, 9 /* EXTENDED_FRAME_BOUNDS */, r, 16) !== 0 && !GetWindowRect(h, r)) return null;
    const d = screen.screenToDipRect(null, { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top });
    return { x: Math.round(d.x), y: Math.round(d.y), w: Math.round(d.width), h: Math.round(d.height) };
  };

  function list(skip) {
    const out = [];
    if (classes.size > 4000) classes.clear();
    EnumWindows((h) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      const id = koffi.address(h);
      if (skip.has(id)) return true;
      if (GetWindowLongW(h, -20) & (0x80 | 0x08000000)) return true; // tool / no-activate windows
      DwmInt(h, 14 /* CLOAKED */, cloaked, 4);
      let cls = classes.get(id);
      if (cls === undefined) classes.set(id, cls = className(h));
      if (cloaked[0] || SKIP.has(cls) || GetWindowTextLengthW(h) === 0) return true;
      const b = rectOf(h);
      if (b && b.w >= 120 && b.h >= 60) out.push({ id: String(id), ...b });
      return true;
    }, 0);
    return out;
  }

  // id of the display covered by a fullscreen foreground app (games, video), else null
  function fullscreen(skip) {
    const h = GetForegroundWindow();
    if (!h || skip.has(koffi.address(h))) return null;
    if (SKIP.has(className(h))) return null;
    const b = rectOf(h);
    if (!b) return null;
    const disp = screen.getDisplayMatching({ x: b.x, y: b.y, width: b.w, height: b.h }), d = disp.bounds;
    return b.x <= d.x && b.y <= d.y && b.x + b.w >= d.x + d.width && b.y + b.h >= d.y + d.height ? disp.id : null;
  }
  return { list, fullscreen };
}

function mac() {
  // ponytail: untested on real macOS hardware — if it throws, the catch above falls back to ground-only snow
  const koffi = require('koffi');
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const CGRect = koffi.struct('CGRect', { x: 'double', y: 'double', w: 'double', h: 'double' });
  const CopyList = cg.func('void *CGWindowListCopyWindowInfo(uint32 opt, uint32 rel)');
  const RectFromDict = cg.func('bool CGRectMakeWithDictionaryRepresentation(void *d, _Out_ CGRect *r)');
  const Count = cf.func('long CFArrayGetCount(void *a)');
  const At = cf.func('void *CFArrayGetValueAtIndex(void *a, long i)');
  const Get = cf.func('void *CFDictionaryGetValue(void *d, void *k)');
  const NumVal = cf.func('bool CFNumberGetValue(void *n, int type, _Out_ int64_t *v)');
  const Str = cf.func('void *CFStringCreateWithCString(void *alloc, const char *s, uint32 enc)');
  const Release = cf.func('void CFRelease(void *p)');
  const K = s => Str(null, s, 0x08000100);
  const kLayer = K('kCGWindowLayer'), kBounds = K('kCGWindowBounds'), kNum = K('kCGWindowNumber'), kPid = K('kCGWindowOwnerPID');
  const v = [0], r = {};
  const num = (d, k) => { const n = Get(d, k); if (!n) return null; NumVal(n, 4 /* SInt64 */, v); return Number(v[0]); };

  function list() {
    const arr = CopyList(1 | 16, 0); // on-screen only, exclude desktop elements
    if (!arr) return [];
    const out = [];
    for (let i = 0, n = Count(arr); i < n; i++) {
      const d = At(arr, i);
      if (num(d, kLayer) !== 0 || num(d, kPid) === process.pid) continue;
      if (!RectFromDict(Get(d, kBounds), r) || r.w < 120 || r.h < 60) continue;
      out.push({ id: String(num(d, kNum)), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
    }
    Release(arr);
    return out;
  }
  return { list, fullscreen: () => null };
}
