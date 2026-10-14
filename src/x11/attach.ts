// Give the AT-SPI backend hands and eyes on X11: XTEST input, screenshots, window activation,
// and screen positions for toolkits that only know window-relative ones.

import type { AtspiBackend } from '../atspi/backend.ts';
import type { NodeHandle } from '../backend.ts';
import type { Rect } from '../model.ts';
import { WINDOW_ROLES } from '../model.ts';
import { X11Connection } from './connection.ts';
import { X11Input } from './input.ts';
import { captureScreen, X11Windows } from './windows.ts';

/** True on a Wayland session, where X11 input would only reach XWayland apps. */
function isWayland(): boolean {
  return process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY;
}

export async function attachX11(backend: AtspiBackend): Promise<void> {
  if (!process.env.DISPLAY) return;
  if (isWayland() && process.env.NORTHBRIDGE_X11 !== '1') return;
  let x: X11Connection;
  try {
    x = await X11Connection.connect();
  } catch {
    return; // no reachable X server: semantic actions still work
  }
  x.weaken();

  const xtest = await x.queryExtension('XTEST').catch(() => null);
  const input = xtest ? await X11Input.create(x, xtest.major) : undefined;
  if (input) backend.input = input;
  backend.screenshot = (rect?: Rect) => captureScreen(x, rect);
  backend.screenBounds = { x: 0, y: 0, width: x.screen.width, height: x.screen.height };

  const windows = new X11Windows(x);

  const windowOf = async (node: NodeHandle): Promise<NodeHandle | null> => {
    let cur: NodeHandle | null = node;
    for (let i = 0; cur && i < 100; i++) {
      const info = await backend.info(cur);
      if (WINDOW_ROLES.has(info.role)) return cur;
      if (info.role === 'application') return null;
      cur = await backend.parent(cur);
    }
    return null;
  };

  // X window ids don't change while a window lives, so remember them (and check they're still there).
  const known = new Map<string, number>();
  const xWindowFor = async (atspiWindow: NodeHandle): Promise<number | null> => {
    const cached = known.get(atspiWindow.key);
    if (cached && (await x.getWindowAttributes(cached).then((a) => a.mapState === 'viewable', () => false))) return cached;
    const [info, pid] = await Promise.all([backend.info(atspiWindow), backend.pidOf(backend.appOf(atspiWindow))]);
    const found = await windows.find(pid, info.name);
    if (found) known.set(atspiWindow.key, found);
    else known.delete(atspiWindow.key);
    return found;
  };

  backend.activateWindow = async (window: NodeHandle) => {
    const xwin = await xWindowFor(window);
    if (!xwin) return false;
    await windows.activate(xwin);
    return true;
  };

  // GTK 4 reports positions relative to its own window even when asked for screen coordinates.
  const needsOffset = async (node: NodeHandle): Promise<boolean> => {
    const toolkit = await backend.toolkit(node);
    return !!toolkit && toolkit.name.toUpperCase() === 'GTK' && toolkit.version.startsWith('4.');
  };
  const screenBounds = backend.bounds.bind(backend);
  backend.bounds = async (node: NodeHandle) => {
    if (!(await needsOffset(node).catch(() => false))) return screenBounds(node);
    const relative = await backend.windowBounds(node);
    if (!relative) return null;
    const window = await windowOf(node);
    const xwin = window ? await xWindowFor(window) : null;
    if (!xwin) return relative;
    const origin = await windows.origin(xwin);
    return { ...relative, x: origin.x + relative.x, y: origin.y + relative.y };
  };

  const close = backend.close.bind(backend);
  backend.close = async () => {
    await input?.restoreKeymap().catch(() => {});
    x.close();
    await close();
  };
}
