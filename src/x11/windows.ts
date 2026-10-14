// Mapping accessible windows to X11 windows: to raise and focus them, and to learn where they
// are on screen (GTK4 only reports positions relative to its own window).

import type { Rect } from '../model.ts';
import { normalizeText } from '../util.ts';
import type { RawImage } from '../backend.ts';
import type { X11Connection } from './connection.ts';

const SUBSTRUCTURE_NOTIFY = 1 << 19;
const SUBSTRUCTURE_REDIRECT = 1 << 20;

export class X11Windows {
  private readonly x: X11Connection;

  constructor(x: X11Connection) {
    this.x = x;
  }

  async hasWindowManager(): Promise<boolean> {
    const [check] = await this.x.getCardinals(this.x.screen.root, '_NET_SUPPORTING_WM_CHECK');
    return !!check;
  }

  /** Application top-level windows (client windows, not WM frames), topmost last. */
  async toplevels(): Promise<number[]> {
    const root = this.x.screen.root;
    const stacking = await this.x.getCardinals(root, '_NET_CLIENT_LIST_STACKING');
    if (stacking.length) return stacking;
    const list = await this.x.getCardinals(root, '_NET_CLIENT_LIST');
    if (list.length) return list;
    // No EWMH window manager: look for ICCCM client windows (with WM_STATE), or mapped
    // non-override-redirect children of the root when nothing manages them at all.
    const { children } = await this.x.queryTree(root);
    const out: number[] = [];
    for (const child of children) {
      const attrs = await this.x.getWindowAttributes(child).catch(() => null);
      if (!attrs || attrs.mapState !== 'viewable' || attrs.overrideRedirect) continue;
      out.push(child);
    }
    return out;
  }

  async pidOf(window: number): Promise<number | undefined> {
    const [pid] = await this.x.getCardinals(window, '_NET_WM_PID');
    return pid;
  }

  async titleOf(window: number): Promise<string> {
    return (await this.x.getString(window, '_NET_WM_NAME')) ?? (await this.x.getString(window, 'WM_NAME')) ?? '';
  }

  /** The X window showing an app's window with this title (topmost wins on ties). */
  async find(pid: number | undefined, title: string): Promise<number | null> {
    const windows = await this.toplevels();
    const info = await Promise.all(
      windows.map(async (w) => ({ w, pid: await this.pidOf(w).catch(() => undefined), title: await this.titleOf(w).catch(() => '') })),
    );
    const wanted = normalizeText(title);
    const titled = (list: typeof info) => list.filter((i) => wanted && normalizeText(i.title) === wanted);
    const sameApp = pid === undefined ? info : info.filter((i) => i.pid === pid);
    // In order: this app's window with that title, this app's only window, any window with that title.
    for (const list of [titled(sameApp), sameApp.length === 1 ? sameApp : [], titled(info)]) {
      if (list.length) return list[list.length - 1].w;
    }
    return null;
  }

  async origin(window: number): Promise<{ x: number; y: number }> {
    return this.x.translateCoordinates(window, this.x.screen.root, 0, 0);
  }

  /** Raise and focus a window, through the window manager when there is one. */
  async activate(window: number): Promise<void> {
    if (await this.hasWindowManager()) {
      const atom = await this.x.internAtom('_NET_ACTIVE_WINDOW');
      this.x.sendClientMessage(window, atom, [2, 0, 0, 0, 0], SUBSTRUCTURE_NOTIFY | SUBSTRUCTURE_REDIRECT);
    } else {
      this.x.mapWindow(window);
      this.x.raiseWindow(window);
      this.x.setInputFocus(window);
    }
    await this.x.sync();
  }
}

/** Grab screen pixels as RGBA. */
export async function captureScreen(x: X11Connection, rect?: Rect): Promise<RawImage> {
  const sw = x.screen.width;
  const sh = x.screen.height;
  const left = Math.max(0, Math.floor(rect?.x ?? 0));
  const top = Math.max(0, Math.floor(rect?.y ?? 0));
  const right = Math.min(sw, Math.ceil(rect ? rect.x + rect.width : sw));
  const bottom = Math.min(sh, Math.ceil(rect ? rect.y + rect.height : sh));
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const image = await x.getImage(left, top, width, height);
  const bpp = x.setup.pixmapFormats.get(image.depth) ?? 32;
  const visual = x.screen.visuals.get(image.visual) ?? x.screen.visuals.get(x.screen.rootVisual);
  const masks = visual ?? { redMask: 0xff0000, greenMask: 0xff00, blueMask: 0xff };
  const stride = Math.ceil((width * bpp) / 32) * 4;
  const out = Buffer.alloc(width * height * 4);
  const little = x.setup.imageByteOrder === 'lsb';
  const channel = (pixel: number, mask: number) => {
    if (!mask) return 0;
    const shift = Math.clz32(mask & -mask) ^ 31;
    const max = mask >>> shift;
    return Math.round((((pixel & mask) >>> shift) * 255) / max);
  };
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const at = row * stride + (col * bpp) / 8;
      let pixel: number;
      if (bpp === 32) pixel = little ? image.data.readUInt32LE(at) : image.data.readUInt32BE(at);
      else if (bpp === 24) pixel = little ? image.data.readUIntLE(at, 3) : image.data.readUIntBE(at, 3);
      else if (bpp === 16) pixel = little ? image.data.readUInt16LE(at) : image.data.readUInt16BE(at);
      else pixel = image.data[at];
      const o = (row * width + col) * 4;
      out[o] = channel(pixel, masks.redMask);
      out[o + 1] = channel(pixel, masks.greenMask);
      out[o + 2] = channel(pixel, masks.blueMask);
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}
