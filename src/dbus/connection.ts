// A small, dependency-free D-Bus client: connects, authenticates, pipelines method calls
// and dispatches signals. Enough of the protocol to talk to AT-SPI and desktop services.

import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import net from 'node:net';
import { join } from 'node:path';
import {
  decodeMessage,
  encodeMessage,
  type Message,
  MessageFlags,
  MessageType,
  messageLength,
  Variant,
} from './wire.ts';

export { Variant } from './wire.ts';

export interface BusAddress {
  transport: string;
  params: Record<string, string>;
}

export function parseAddress(address: string): BusAddress[] {
  return address
    .split(';')
    .filter(Boolean)
    .map((entry) => {
      const colon = entry.indexOf(':');
      const transport = entry.slice(0, colon);
      const params: Record<string, string> = {};
      for (const pair of entry.slice(colon + 1).split(',')) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        params[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
      }
      return { transport, params };
    });
}

/** The session bus address from the environment, falling back to the systemd user bus. */
export function sessionBusAddress(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.DBUS_SESSION_BUS_ADDRESS) return env.DBUS_SESSION_BUS_ADDRESS;
  const runtime = env.XDG_RUNTIME_DIR ?? (process.getuid ? `/run/user/${process.getuid()}` : undefined);
  if (runtime && existsSync(join(runtime, 'bus'))) return `unix:path=${join(runtime, 'bus')}`;
  return undefined;
}

export class DBusError extends Error {
  /** The D-Bus error name, e.g. `org.freedesktop.DBus.Error.UnknownMethod`. */
  readonly type: string;
  readonly body: unknown[];
  constructor(type: string, message: string, body: unknown[] = []) {
    super(message ? `${type}: ${message}` : type);
    this.name = 'DBusError';
    this.type = type;
    this.body = body;
  }
}

export interface MethodCall {
  destination?: string;
  path: string;
  interface?: string;
  member: string;
  signature?: string;
  body?: unknown[];
}

export interface CallOptions {
  /** Milliseconds to wait for the reply. Defaults to the connection's `defaultTimeout`. */
  timeout?: number;
  /** Don't auto-start the destination service. */
  noAutoStart?: boolean;
  /** Don't keep the process alive while waiting for this reply. */
  background?: boolean;
}

export interface SignalFilter {
  sender?: string;
  path?: string;
  pathNamespace?: string;
  interface?: string;
  member?: string;
}

export type SignalHandler = (msg: Message) => void;

interface Pending {
  resolve: (body: unknown[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | undefined;
  call: MethodCall;
  background: boolean;
}

function openSocket(addr: BusAddress): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let socket: net.Socket;
    if (addr.transport === 'unix') {
      const { path, abstract } = addr.params;
      if (path) socket = net.connect({ path });
      else if (abstract) socket = net.connect({ path: `\0${abstract}` });
      else return reject(new Error(`Unsupported unix bus address: ${JSON.stringify(addr.params)}`));
    } else if (addr.transport === 'tcp') {
      socket = net.connect({ host: addr.params.host ?? 'localhost', port: Number(addr.params.port) });
    } else {
      return reject(new Error(`Unsupported D-Bus transport "${addr.transport}"`));
    }
    const onError = (err: Error) => reject(err);
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.off('error', onError);
      resolve(socket);
    });
  });
}

const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex');

/** Runs the SASL handshake. Resolves with any bytes received after `BEGIN`. */
function authenticate(socket: net.Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const mechanisms: string[] = [];
    if (process.getuid) mechanisms.push('EXTERNAL');
    mechanisms.push('DBUS_COOKIE_SHA1', 'ANONYMOUS');
    let current = '';
    let done = false;

    const cleanup = () => {
      done = true;
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const fail = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onError = (err: Error) => fail(err);
    const onClose = () => fail(new Error('D-Bus connection closed during authentication'));
    const tryNext = () => {
      const mech = mechanisms.shift();
      if (!mech) return fail(new Error('D-Bus authentication failed: no mechanism accepted'));
      current = mech;
      if (mech === 'EXTERNAL') socket.write(`AUTH EXTERNAL ${hex(String(process.getuid!()))}\r\n`);
      else if (mech === 'DBUS_COOKIE_SHA1') socket.write(`AUTH DBUS_COOKIE_SHA1 ${hex(userInfo().username)}\r\n`);
      else socket.write(`AUTH ANONYMOUS ${hex('northbridge')}\r\n`);
    };
    const onLine = (line: string) => {
      const [cmd, ...args] = line.split(' ');
      if (cmd === 'OK') {
        socket.write('BEGIN\r\n');
        cleanup();
        resolve(buffer);
        return;
      }
      if (cmd === 'REJECTED') return tryNext();
      if (cmd === 'DATA' && current === 'DBUS_COOKIE_SHA1') {
        try {
          const [context, cookieId, serverChallenge] = Buffer.from(args[0], 'hex').toString('utf8').split(' ');
          const keyring = readFileSync(join(homedir(), '.dbus-keyrings', context), 'utf8');
          const cookie = keyring
            .split('\n')
            .map((l) => l.split(' '))
            .find((parts) => parts[0] === cookieId)?.[2];
          if (!cookie) throw new Error('cookie not found');
          const clientChallenge = randomBytes(16).toString('hex');
          const digest = createHash('sha1').update(`${serverChallenge}:${clientChallenge}:${cookie}`).digest('hex');
          socket.write(`DATA ${hex(`${clientChallenge} ${digest}`)}\r\n`);
        } catch {
          socket.write('CANCEL\r\n');
        }
        return;
      }
      if (cmd === 'DATA' || cmd === 'ERROR') {
        socket.write('CANCEL\r\n');
        return;
      }
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let idx: number;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.subarray(0, idx).toString('ascii');
        buffer = buffer.subarray(idx + 2);
        onLine(line);
        if (done) return;
      }
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.write(Buffer.from([0]));
    tryNext();
  });
}

function matchRule(filter: SignalFilter): string {
  const parts = ["type='signal'"];
  if (filter.sender) parts.push(`sender='${filter.sender}'`);
  if (filter.path) parts.push(`path='${filter.path}'`);
  if (filter.pathNamespace) parts.push(`path_namespace='${filter.pathNamespace}'`);
  if (filter.interface) parts.push(`interface='${filter.interface}'`);
  if (filter.member) parts.push(`member='${filter.member}'`);
  return parts.join(',');
}

function matches(filter: SignalFilter, msg: Message): boolean {
  if (filter.sender && filter.sender !== msg.sender) return false;
  if (filter.path && filter.path !== msg.path) return false;
  if (filter.pathNamespace && msg.path !== filter.pathNamespace && !msg.path?.startsWith(`${filter.pathNamespace}/`)) return false;
  if (filter.interface && filter.interface !== msg.interface) return false;
  if (filter.member && filter.member !== msg.member) return false;
  return true;
}

export class DBusConnection extends EventEmitter {
  /** Our unique bus name, e.g. `:1.42`. */
  uniqueName = '';
  defaultTimeout = 25_000;
  private readonly socket: net.Socket;
  private serial = 0;
  private readonly pending = new Map<number, Pending>();
  private buffer: Buffer = Buffer.alloc(0);
  private readonly signalHandlers = new Set<{ filter: SignalFilter; handler: SignalHandler }>();
  private closedError: Error | undefined;
  private weak = false;
  /** Pending calls that should keep the process alive. */
  private strong = 0;

  private constructor(socket: net.Socket, leftover: Buffer) {
    super();
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err) => this.shutdown(err));
    socket.on('close', () => this.shutdown(new Error('D-Bus connection closed')));
    if (leftover.length) this.onData(leftover);
  }

  /** Connect to a bus by address (e.g. `unix:path=/run/user/1000/bus`). */
  static async connect(address: string): Promise<DBusConnection> {
    let lastError: unknown;
    for (const addr of parseAddress(address)) {
      let socket: net.Socket | undefined;
      try {
        socket = await openSocket(addr);
        const leftover = await authenticate(socket);
        const conn = new DBusConnection(socket, leftover);
        const [name] = await conn.call({
          destination: 'org.freedesktop.DBus',
          path: '/org/freedesktop/DBus',
          interface: 'org.freedesktop.DBus',
          member: 'Hello',
        });
        conn.uniqueName = name as string;
        return conn;
      } catch (err) {
        socket?.destroy();
        lastError = err;
      }
    }
    throw new Error(`Could not connect to D-Bus at ${address}: ${(lastError as Error)?.message ?? 'no usable address'}`);
  }

  static async session(): Promise<DBusConnection> {
    const address = sessionBusAddress();
    if (!address) throw new Error('No D-Bus session bus found (DBUS_SESSION_BUS_ADDRESS is not set)');
    return DBusConnection.connect(address);
  }

  get closed(): boolean {
    return this.closedError !== undefined;
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const len = messageLength(this.buffer);
      if (len < 0) break;
      const raw = this.buffer.subarray(0, len);
      this.buffer = this.buffer.subarray(len);
      let msg: Message;
      try {
        msg = decodeMessage(raw);
      } catch (err) {
        this.emit('warning', err);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Message): void {
    switch (msg.type) {
      case MessageType.MethodReturn:
      case MessageType.Error: {
        const pending = msg.replySerial !== undefined ? this.pending.get(msg.replySerial) : undefined;
        if (!pending) return;
        this.removePending(msg.replySerial!);
        if (pending.timer) clearTimeout(pending.timer);
        if (msg.type === MessageType.Error) {
          const text = typeof msg.body?.[0] === 'string' ? (msg.body[0] as string) : '';
          pending.reject(new DBusError(msg.errorName ?? 'org.freedesktop.DBus.Error.Failed', text, msg.body));
        } else {
          pending.resolve(msg.body ?? []);
        }
        return;
      }
      case MessageType.Signal:
        for (const { filter, handler } of this.signalHandlers) {
          if (!matches(filter, msg)) continue;
          try {
            handler(msg);
          } catch (err) {
            this.emit('warning', err);
          }
        }
        return;
      case MessageType.MethodCall:
        this.answerIncomingCall(msg);
        return;
    }
  }

  private answerIncomingCall(msg: Message): void {
    if ((msg.flags ?? 0) & MessageFlags.NoReplyExpected) return;
    const reply = (m: Partial<Message>) => {
      this.write({ type: MessageType.MethodReturn, destination: msg.sender, replySerial: msg.serial, ...m });
    };
    if (msg.interface === 'org.freedesktop.DBus.Peer' && msg.member === 'Ping') return reply({});
    if (msg.interface === 'org.freedesktop.DBus.Peer' && msg.member === 'GetMachineId') {
      let id = '';
      try {
        id = readFileSync('/etc/machine-id', 'utf8').trim();
      } catch {}
      return reply({ signature: 's', body: [id] });
    }
    this.write({
      type: MessageType.Error,
      destination: msg.sender,
      replySerial: msg.serial,
      errorName: 'org.freedesktop.DBus.Error.UnknownMethod',
      signature: 's',
      body: [`No such method ${msg.interface}.${msg.member}`],
    });
  }

  private write(msg: Message): number {
    if (this.closedError) throw this.closedError;
    this.serial = (this.serial % 0xfffffffe) + 1;
    this.socket.write(encodeMessage(msg, this.serial));
    return this.serial;
  }

  /** Call a method and resolve with the reply body. Calls are pipelined, so fire many at once. */
  call(call: MethodCall, options: CallOptions = {}): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      if (this.closedError) return reject(this.closedError);
      let serial: number;
      try {
        serial = this.write({
          type: MessageType.MethodCall,
          flags: options.noAutoStart ? MessageFlags.NoAutoStart : 0,
          ...call,
        });
      } catch (err) {
        return reject(err);
      }
      const timeout = options.timeout ?? this.defaultTimeout;
      const timer =
        timeout > 0 && Number.isFinite(timeout)
          ? setTimeout(() => {
              this.removePending(serial);
              reject(
                new DBusError(
                  'org.freedesktop.DBus.Error.Timeout',
                  `${call.interface}.${call.member} on ${call.destination}${call.path} timed out after ${timeout}ms`,
                ),
              );
            }, timeout)
          : undefined;
      timer?.unref?.();
      const background = !!options.background;
      if (!background && this.strong++ === 0 && this.weak) this.socket.ref();
      this.pending.set(serial, { resolve, reject, timer, call, background });
    });
  }

  /** Send a method call without waiting for (or wanting) a reply. */
  callNoReply(call: MethodCall): void {
    this.write({ type: MessageType.MethodCall, flags: MessageFlags.NoReplyExpected, ...call });
  }

  async getProperty(destination: string, path: string, iface: string, name: string, options?: CallOptions): Promise<unknown> {
    const [value] = await this.call(
      { destination, path, interface: 'org.freedesktop.DBus.Properties', member: 'Get', signature: 'ss', body: [iface, name] },
      options,
    );
    return value;
  }

  async getAllProperties(destination: string, path: string, iface: string, options?: CallOptions): Promise<Record<string, unknown>> {
    const [value] = await this.call(
      { destination, path, interface: 'org.freedesktop.DBus.Properties', member: 'GetAll', signature: 's', body: [iface] },
      options,
    );
    return value as Record<string, unknown>;
  }

  async setProperty(destination: string, path: string, iface: string, name: string, value: Variant, options?: CallOptions): Promise<void> {
    await this.call(
      { destination, path, interface: 'org.freedesktop.DBus.Properties', member: 'Set', signature: 'ssv', body: [iface, name, value] },
      options,
    );
  }

  /** Call a method on the bus daemon itself. */
  bus(member: string, signature = '', body: unknown[] = []): Promise<unknown[]> {
    return this.call({
      destination: 'org.freedesktop.DBus',
      path: '/org/freedesktop/DBus',
      interface: 'org.freedesktop.DBus',
      member,
      signature,
      body,
    });
  }

  /** Listen for signals locally (doesn't ask the bus to route anything; see `subscribe`). */
  onSignal(filter: SignalFilter, handler: SignalHandler): () => void {
    const entry = { filter, handler };
    this.signalHandlers.add(entry);
    return () => {
      this.signalHandlers.delete(entry);
    };
  }

  /** Ask the bus to route matching signals to us and listen for them. Resolves with an unsubscribe function. */
  async subscribe(filter: SignalFilter, handler: SignalHandler): Promise<() => Promise<void>> {
    const rule = matchRule(filter);
    await this.bus('AddMatch', 's', [rule]);
    const off = this.onSignal(filter, handler);
    return async () => {
      off();
      if (!this.closed) await this.bus('RemoveMatch', 's', [rule]).catch(() => {});
    };
  }

  private shutdown(err: Error): void {
    if (this.closedError) return;
    this.closedError = err;
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    this.socket.destroy();
    this.emit('close', err);
  }

  close(): void {
    this.shutdown(new Error('D-Bus connection closed'));
  }

  private removePending(serial: number): void {
    const pending = this.pending.get(serial);
    if (!pending) return;
    this.pending.delete(serial);
    if (!pending.background && --this.strong === 0 && this.weak) this.socket.unref();
  }

  /** Let the process exit while this connection is idle. Calls in flight still keep it alive. */
  unref(): void {
    this.weak = true;
    if (this.strong === 0) this.socket.unref();
  }

  ref(): void {
    this.weak = false;
    this.socket.ref();
  }
}
