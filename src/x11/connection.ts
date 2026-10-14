// A minimal X11 protocol client: just enough for XTEST input, keyboard mappings, window
// lookup and screen capture. https://www.x.org/releases/current/doc/xproto/x11protocol.html

import { existsSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import net from 'node:net';
import { join } from 'node:path';

export interface Visual {
  id: number;
  depth: number;
  redMask: number;
  greenMask: number;
  blueMask: number;
}

export interface Screen {
  root: number;
  width: number;
  height: number;
  rootDepth: number;
  rootVisual: number;
  visuals: Map<number, Visual>;
}

export interface Setup {
  resourceIdBase: number;
  resourceIdMask: number;
  minKeycode: number;
  maxKeycode: number;
  imageByteOrder: 'lsb' | 'msb';
  /** depth → bits per pixel */
  pixmapFormats: Map<number, number>;
  screens: Screen[];
}

export class X11Error extends Error {
  readonly code: number;
  constructor(code: number, opcode: number, minor: number, bad: number) {
    const names: Record<number, string> = {
      1: 'BadRequest', 2: 'BadValue', 3: 'BadWindow', 4: 'BadPixmap', 5: 'BadAtom', 8: 'BadMatch',
      9: 'BadDrawable', 10: 'BadAccess', 11: 'BadAlloc', 16: 'BadLength', 17: 'BadImplementation',
    };
    super(`X11 ${names[code] ?? `error ${code}`} (request ${opcode}.${minor}, value 0x${bad.toString(16)})`);
    this.name = 'X11Error';
    this.code = code;
  }
}

interface Pending {
  resolve: (reply: Buffer) => void;
  reject: (err: Error) => void;
}

const pad4 = (n: number) => (4 - (n % 4)) % 4;

interface DisplayAddress {
  host: string;
  display: number;
  screen: number;
}

export function parseDisplay(display: string): DisplayAddress {
  const m = /^(.*):(\d+)(?:\.(\d+))?$/.exec(display);
  if (!m) throw new Error(`Can't parse DISPLAY ${JSON.stringify(display)}`);
  return { host: m[1], display: Number(m[2]), screen: Number(m[3] ?? 0) };
}

/** Find the MIT-MAGIC-COOKIE-1 for a display in ~/.Xauthority (or $XAUTHORITY). */
function readCookie(addr: DisplayAddress): { name: string; data: Buffer } | null {
  const file = process.env.XAUTHORITY ?? join(homedir(), '.Xauthority');
  if (!existsSync(file)) return null;
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch {
    return null;
  }
  const local = !addr.host || addr.host === 'unix' || addr.host === 'localhost';
  const host = hostname();
  let pos = 0;
  const field = () => {
    const len = buf.readUInt16BE(pos);
    const value = buf.subarray(pos + 2, pos + 2 + len);
    pos += 2 + len;
    return value;
  };
  let fallback: { name: string; data: Buffer } | null = null;
  while (pos + 2 <= buf.length) {
    const family = buf.readUInt16BE(pos);
    pos += 2;
    const address = field().toString('latin1');
    const number = field().toString('latin1');
    const name = field().toString('latin1');
    const data = Buffer.from(field());
    if (name !== 'MIT-MAGIC-COOKIE-1') continue;
    if (number !== '' && number !== String(addr.display)) continue;
    const wild = family === 0xffff;
    const familyLocal = family === 256;
    if (wild || (local && familyLocal && address === host)) return { name, data };
    if (local && familyLocal) fallback ??= { name, data };
  }
  return fallback;
}

function openSocket(addr: DisplayAddress): Promise<net.Socket> {
  const attempts: net.NetConnectOpts[] = [];
  if (!addr.host || addr.host === 'unix') {
    attempts.push({ path: `/tmp/.X11-unix/X${addr.display}` });
    // Linux servers also listen on the abstract namespace, which works inside sandboxes.
    if (process.platform === 'linux') attempts.push({ path: `\0/tmp/.X11-unix/X${addr.display}` });
  } else if (addr.host.startsWith('/')) {
    // XQuartz-style launchd socket path
    attempts.push({ path: `${addr.host}:${addr.display}` });
  } else {
    attempts.push({ host: addr.host, port: 6000 + addr.display });
  }
  return new Promise((resolve, reject) => {
    const tryNext = (lastError?: Error) => {
      const opts = attempts.shift();
      if (!opts) return reject(lastError ?? new Error('No way to reach the X server'));
      const socket = net.connect(opts);
      socket.once('connect', () => {
        socket.removeAllListeners('error');
        resolve(socket);
      });
      socket.once('error', (err) => tryNext(err));
    };
    tryNext();
  });
}

export class X11Connection {
  readonly setup: Setup;
  readonly screen: Screen;
  private readonly socket: net.Socket;
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  private buffer: Buffer = Buffer.alloc(0);
  private closedError: Error | undefined;
  private readonly atoms = new Map<string, number>();
  private readonly extensions = new Map<string, { major: number } | null>();

  private constructor(socket: net.Socket, setup: Setup, screen: number, leftover: Buffer) {
    this.socket = socket;
    this.setup = setup;
    this.screen = setup.screens[screen] ?? setup.screens[0];
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err) => this.shutdown(err));
    socket.on('close', () => this.shutdown(new Error('X11 connection closed')));
    if (leftover.length) this.onData(leftover);
  }

  static async connect(display = process.env.DISPLAY): Promise<X11Connection> {
    if (!display) throw new Error('DISPLAY is not set');
    const addr = parseDisplay(display);
    const socket = await openSocket(addr);
    const cookie = readCookie(addr);
    const name = Buffer.from(cookie?.name ?? '', 'latin1');
    const data = cookie?.data ?? Buffer.alloc(0);
    const req = Buffer.alloc(12 + name.length + pad4(name.length) + data.length + pad4(data.length));
    req[0] = 0x6c; // 'l': little-endian
    req.writeUInt16LE(11, 2);
    req.writeUInt16LE(0, 4);
    req.writeUInt16LE(name.length, 6);
    req.writeUInt16LE(data.length, 8);
    name.copy(req, 12);
    data.copy(req, 12 + name.length + pad4(name.length));
    socket.write(req);
    const { setup, leftover } = await new Promise<{ setup: Setup; leftover: Buffer }>((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 8) return;
        const total = 8 + buf.readUInt16LE(6) * 4;
        if (buf.length < total) return;
        socket.off('data', onData);
        socket.off('error', reject);
        const status = buf[0];
        if (status !== 1) {
          const reason = buf.subarray(8, 8 + buf[1]).toString('latin1');
          reject(new Error(`X server refused the connection: ${reason || (status === 2 ? 'authentication required' : 'failed')}`));
          return;
        }
        resolve({ setup: parseSetup(buf.subarray(0, total)), leftover: buf.subarray(total) });
      };
      socket.on('data', onData);
      socket.once('error', reject);
    });
    return new X11Connection(socket, setup, addr.screen, leftover);
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 32) {
      const kind = this.buffer[0];
      let length = 32;
      if (kind === 1 || (kind & 0x7f) === 35) length = 32 + this.buffer.readUInt32LE(4) * 4;
      if (this.buffer.length < length) break;
      const packet = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      const seq = packet.readUInt16LE(2);
      if (kind === 1) {
        const p = this.pending.get(seq);
        if (p) {
          this.pending.delete(seq);
          p.resolve(Buffer.from(packet));
        }
      } else if (kind === 0) {
        const err = new X11Error(packet[1], packet[10], packet.readUInt16LE(8), packet.readUInt32LE(4));
        const p = this.pending.get(seq);
        if (p) {
          this.pending.delete(seq);
          p.reject(err);
        }
      }
      // Events are ignored; we never select for any.
    }
  }

  private shutdown(err: Error): void {
    if (this.closedError) return;
    this.closedError = err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.socket.destroy();
  }

  close(): void {
    this.shutdown(new Error('X11 connection closed'));
  }

  unref(): void {
    this.socket.unref();
  }

  /** Send a request. `body` excludes the 4-byte header; it is padded to a multiple of 4. */
  private send(opcode: number, data: number, body: Buffer): number {
    if (this.closedError) throw this.closedError;
    const padded = body.length + pad4(body.length);
    const req = Buffer.alloc(4 + padded);
    req[0] = opcode;
    req[1] = data;
    req.writeUInt16LE((4 + padded) / 4, 2);
    body.copy(req, 4);
    this.socket.write(req);
    this.sequence = (this.sequence + 1) & 0xffff;
    return this.sequence;
  }

  /** A request that has a reply. */
  request(opcode: number, data: number, body: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let seq: number;
      try {
        seq = this.send(opcode, data, body);
      } catch (err) {
        return reject(err);
      }
      this.socket.ref();
      this.pending.set(seq, {
        resolve: (b) => {
          this.maybeUnref();
          resolve(b);
        },
        reject: (e) => {
          this.maybeUnref();
          reject(e);
        },
      });
    });
  }

  private weak = false;
  private maybeUnref(): void {
    if (this.weak && this.pending.size === 0) this.socket.unref();
  }
  /** Let the process exit while idle. */
  weaken(): void {
    this.weak = true;
    this.maybeUnref();
  }

  /** A request without a reply. Errors surface on the next `sync()`. */
  void(opcode: number, data: number, body: Buffer): void {
    this.send(opcode, data, body);
  }

  /** Round-trip to the server so everything sent so far has been processed. */
  async sync(): Promise<void> {
    await this.request(43, 0, Buffer.alloc(0)); // GetInputFocus
  }

  // ---------------------------------------------------------------------------------------------
  // Requests

  async internAtom(name: string, onlyIfExists = false): Promise<number> {
    const cached = this.atoms.get(name);
    if (cached !== undefined) return cached;
    const n = Buffer.from(name, 'latin1');
    const body = Buffer.alloc(4 + n.length);
    body.writeUInt16LE(n.length, 0);
    n.copy(body, 4);
    const reply = await this.request(16, onlyIfExists ? 1 : 0, body);
    const atom = reply.readUInt32LE(8);
    if (atom) this.atoms.set(name, atom);
    return atom;
  }

  async queryExtension(name: string): Promise<{ major: number } | null> {
    if (this.extensions.has(name)) return this.extensions.get(name)!;
    const n = Buffer.from(name, 'latin1');
    const body = Buffer.alloc(4 + n.length);
    body.writeUInt16LE(n.length, 0);
    n.copy(body, 4);
    const reply = await this.request(98, 0, body);
    const result = reply[8] ? { major: reply[9] } : null;
    this.extensions.set(name, result);
    return result;
  }

  async getProperty(window: number, property: string, maxLength = 1 << 16): Promise<{ type: number; format: number; data: Buffer } | null> {
    const atom = await this.internAtom(property, true);
    if (!atom) return null;
    const body = Buffer.alloc(20);
    body.writeUInt32LE(window, 0);
    body.writeUInt32LE(atom, 4);
    body.writeUInt32LE(0, 8); // AnyPropertyType
    body.writeUInt32LE(0, 12);
    body.writeUInt32LE(maxLength, 16);
    const reply = await this.request(20, 0, body);
    const format = reply[1];
    const type = reply.readUInt32LE(8);
    if (!type) return null;
    const count = reply.readUInt32LE(16);
    const bytes = count * (format / 8);
    return { type, format, data: Buffer.from(reply.subarray(32, 32 + bytes)) };
  }

  async getCardinals(window: number, property: string): Promise<number[]> {
    const prop = await this.getProperty(window, property).catch(() => null);
    if (!prop || prop.format !== 32) return [];
    const out: number[] = [];
    for (let i = 0; i + 4 <= prop.data.length; i += 4) out.push(prop.data.readUInt32LE(i));
    return out;
  }

  async getString(window: number, property: string): Promise<string | null> {
    const prop = await this.getProperty(window, property).catch(() => null);
    if (!prop || prop.format !== 8) return null;
    return prop.data.toString(property === 'WM_NAME' ? 'latin1' : 'utf8');
  }

  async queryTree(window: number): Promise<{ root: number; parent: number; children: number[] }> {
    const body = Buffer.alloc(4);
    body.writeUInt32LE(window, 0);
    const reply = await this.request(15, 0, body);
    const n = reply.readUInt16LE(16);
    const children: number[] = [];
    for (let i = 0; i < n; i++) children.push(reply.readUInt32LE(32 + i * 4));
    return { root: reply.readUInt32LE(8), parent: reply.readUInt32LE(12), children };
  }

  async getGeometry(drawable: number): Promise<{ x: number; y: number; width: number; height: number; depth: number }> {
    const body = Buffer.alloc(4);
    body.writeUInt32LE(drawable, 0);
    const reply = await this.request(14, 0, body);
    return {
      depth: reply[1],
      x: reply.readInt16LE(12),
      y: reply.readInt16LE(14),
      width: reply.readUInt16LE(16),
      height: reply.readUInt16LE(18),
    };
  }

  async getWindowAttributes(window: number): Promise<{ mapState: 'unmapped' | 'unviewable' | 'viewable'; overrideRedirect: boolean }> {
    const body = Buffer.alloc(4);
    body.writeUInt32LE(window, 0);
    const reply = await this.request(3, 0, body);
    const states = ['unmapped', 'unviewable', 'viewable'] as const;
    return { mapState: states[reply[26]] ?? 'unmapped', overrideRedirect: reply[27] !== 0 };
  }

  async translateCoordinates(src: number, dst: number, x: number, y: number): Promise<{ x: number; y: number }> {
    const body = Buffer.alloc(12);
    body.writeUInt32LE(src, 0);
    body.writeUInt32LE(dst, 4);
    body.writeInt16LE(x, 8);
    body.writeInt16LE(y, 10);
    const reply = await this.request(40, 0, body);
    return { x: reply.readInt16LE(12), y: reply.readInt16LE(14) };
  }

  async queryPointer(): Promise<{ x: number; y: number }> {
    const body = Buffer.alloc(4);
    body.writeUInt32LE(this.screen.root, 0);
    const reply = await this.request(38, 0, body);
    return { x: reply.readInt16LE(16), y: reply.readInt16LE(18) };
  }

  async getKeyboardMapping(): Promise<{ perKeycode: number; keysyms: number[][] }> {
    const { minKeycode, maxKeycode } = this.setup;
    const count = maxKeycode - minKeycode + 1;
    const body = Buffer.alloc(4);
    body[0] = minKeycode;
    body[1] = count;
    const reply = await this.request(101, 0, body);
    const perKeycode = reply[1];
    const keysyms: number[][] = [];
    for (let k = 0; k < count; k++) {
      const row: number[] = [];
      for (let j = 0; j < perKeycode; j++) row.push(reply.readUInt32LE(32 + (k * perKeycode + j) * 4));
      keysyms.push(row);
    }
    return { perKeycode, keysyms };
  }

  changeKeyboardMapping(firstKeycode: number, perKeycode: number, keysyms: number[][]): void {
    const body = Buffer.alloc(4 + keysyms.length * perKeycode * 4);
    body[0] = firstKeycode;
    body[1] = perKeycode;
    keysyms.forEach((row, k) => {
      for (let j = 0; j < perKeycode; j++) body.writeUInt32LE(row[j] ?? 0, 4 + (k * perKeycode + j) * 4);
    });
    this.void(100, keysyms.length, body);
  }

  async getModifierMapping(): Promise<number[][]> {
    const reply = await this.request(119, 0, Buffer.alloc(0));
    const per = reply[1];
    const mods: number[][] = [];
    for (let m = 0; m < 8; m++) {
      const codes: number[] = [];
      for (let i = 0; i < per; i++) {
        const code = reply[32 + m * per + i];
        if (code) codes.push(code);
      }
      mods.push(codes);
    }
    return mods;
  }

  /** XTEST FakeInput: type 2 KeyPress, 3 KeyRelease, 4 ButtonPress, 5 ButtonRelease, 6 MotionNotify. */
  fakeInput(major: number, type: number, detail: number, x = 0, y = 0): void {
    const body = Buffer.alloc(32);
    body[0] = type;
    body[1] = detail;
    body.writeUInt32LE(0, 4); // time: CurrentTime
    body.writeUInt32LE(type === 6 ? this.screen.root : 0, 8);
    body.writeInt16LE(x, 20);
    body.writeInt16LE(y, 22);
    this.void(major, 2, body);
  }

  async getImage(x: number, y: number, width: number, height: number): Promise<{ depth: number; visual: number; data: Buffer }> {
    const body = Buffer.alloc(16);
    body.writeUInt32LE(this.screen.root, 0);
    body.writeInt16LE(x, 4);
    body.writeInt16LE(y, 6);
    body.writeUInt16LE(width, 8);
    body.writeUInt16LE(height, 10);
    body.writeUInt32LE(0xffffffff, 12);
    const reply = await this.request(73, 2, body); // ZPixmap
    return { depth: reply[1], visual: reply.readUInt32LE(8), data: reply.subarray(32) };
  }

  sendClientMessage(window: number, type: number, data: number[], eventMask: number): void {
    const body = Buffer.alloc(40);
    body.writeUInt32LE(this.screen.root, 0); // destination
    body.writeUInt32LE(eventMask, 4);
    const ev = body.subarray(8);
    ev[0] = 33; // ClientMessage
    ev[1] = 32; // format
    ev.writeUInt32LE(window, 4);
    ev.writeUInt32LE(type, 8);
    data.slice(0, 5).forEach((v, i) => ev.writeUInt32LE(v >>> 0, 12 + i * 4));
    this.void(25, 0, body); // SendEvent, propagate = false
  }

  raiseWindow(window: number): void {
    const body = Buffer.alloc(12);
    body.writeUInt32LE(window, 0);
    body.writeUInt16LE(0x40, 4); // StackMode
    body.writeUInt32LE(0, 8); // Above
    this.void(12, 0, body);
  }

  setInputFocus(window: number): void {
    const body = Buffer.alloc(8);
    body.writeUInt32LE(window, 0);
    body.writeUInt32LE(0, 4); // CurrentTime
    this.void(42, 2, body); // revert-to Parent
  }

  mapWindow(window: number): void {
    const body = Buffer.alloc(4);
    body.writeUInt32LE(window, 0);
    this.void(8, 0, body);
  }
}

function parseSetup(buf: Buffer): Setup {
  const vendorLength = buf.readUInt16LE(24);
  const screenCount = buf[28];
  const formatCount = buf[29];
  const setup: Setup = {
    resourceIdBase: buf.readUInt32LE(12),
    resourceIdMask: buf.readUInt32LE(16),
    imageByteOrder: buf[30] === 0 ? 'lsb' : 'msb',
    minKeycode: buf[34],
    maxKeycode: buf[35],
    pixmapFormats: new Map(),
    screens: [],
  };
  let pos = 40 + vendorLength + pad4(vendorLength);
  for (let i = 0; i < formatCount; i++) {
    setup.pixmapFormats.set(buf[pos], buf[pos + 1]);
    pos += 8;
  }
  for (let s = 0; s < screenCount; s++) {
    const screen: Screen = {
      root: buf.readUInt32LE(pos),
      width: buf.readUInt16LE(pos + 20),
      height: buf.readUInt16LE(pos + 22),
      rootVisual: buf.readUInt32LE(pos + 32),
      rootDepth: buf[pos + 38],
      visuals: new Map(),
    };
    const depthCount = buf[pos + 39];
    pos += 40;
    for (let d = 0; d < depthCount; d++) {
      const depth = buf[pos];
      const visualCount = buf.readUInt16LE(pos + 2);
      pos += 8;
      for (let v = 0; v < visualCount; v++) {
        const id = buf.readUInt32LE(pos);
        screen.visuals.set(id, {
          id,
          depth,
          redMask: buf.readUInt32LE(pos + 8),
          greenMask: buf.readUInt32LE(pos + 12),
          blueMask: buf.readUInt32LE(pos + 16),
        });
        pos += 24;
      }
    }
    setup.screens.push(screen);
  }
  return setup;
}
