// D-Bus wire format: type signatures, marshalling and message framing.
// Spec: https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol

export type TypeCode =
  | 'y' | 'b' | 'n' | 'q' | 'i' | 'u' | 'x' | 't' | 'd' | 'h'
  | 's' | 'o' | 'g' | 'v' | 'a' | '(' | '{';

export interface TypeNode {
  code: TypeCode;
  /** Element type for arrays, field types for structs, [key, value] for dict entries. */
  children: TypeNode[];
  /** The signature string this node was parsed from. */
  signature: string;
}

/** A value whose D-Bus type must be spelled out (used when marshalling variants). */
export class Variant {
  readonly signature: string;
  readonly value: unknown;
  constructor(signature: string, value: unknown) {
    this.signature = signature;
    this.value = value;
  }
}

const BASIC = new Set('ybnqiuxtdhsog');
const signatureCache = new Map<string, TypeNode[]>();

export function parseSignature(signature: string): TypeNode[] {
  const cached = signatureCache.get(signature);
  if (cached) return cached;
  let pos = 0;
  const parseOne = (): TypeNode => {
    const start = pos;
    const c = signature[pos++];
    if (c === undefined) throw new Error(`Truncated D-Bus signature "${signature}"`);
    if (BASIC.has(c) || c === 'v') return { code: c as TypeCode, children: [], signature: c };
    if (c === 'a') {
      const elem = parseOne();
      return { code: 'a', children: [elem], signature: signature.slice(start, pos) };
    }
    if (c === '(') {
      const fields: TypeNode[] = [];
      while (signature[pos] !== ')') {
        if (pos >= signature.length) throw new Error(`Unterminated struct in signature "${signature}"`);
        fields.push(parseOne());
      }
      pos++;
      return { code: '(', children: fields, signature: signature.slice(start, pos) };
    }
    if (c === '{') {
      const key = parseOne();
      const value = parseOne();
      if (signature[pos++] !== '}') throw new Error(`Bad dict entry in signature "${signature}"`);
      return { code: '{', children: [key, value], signature: signature.slice(start, pos) };
    }
    throw new Error(`Unknown type code "${c}" in signature "${signature}"`);
  };
  const types: TypeNode[] = [];
  while (pos < signature.length) types.push(parseOne());
  if (signatureCache.size > 1000) signatureCache.clear();
  signatureCache.set(signature, types);
  return types;
}

function alignmentOf(code: TypeCode): number {
  switch (code) {
    case 'y': case 'g': case 'v': return 1;
    case 'n': case 'q': return 2;
    case 'x': case 't': case 'd': case '(': case '{': return 8;
    default: return 4;
  }
}

// ---------------------------------------------------------------------------
// Writer

export class Writer {
  buf: Buffer;
  pos = 0;
  constructor(size = 256) {
    this.buf = Buffer.alloc(size);
  }
  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = Buffer.alloc(size);
    this.buf.copy(next, 0, 0, this.pos);
    this.buf = next;
  }
  align(n: number): void {
    const pad = (n - (this.pos % n)) % n;
    if (pad) {
      this.ensure(pad);
      this.buf.fill(0, this.pos, this.pos + pad);
      this.pos += pad;
    }
  }
  u8(v: number): void { this.ensure(1); this.buf.writeUInt8(v & 0xff, this.pos); this.pos += 1; }
  i16(v: number): void { this.align(2); this.ensure(2); this.buf.writeInt16LE(v, this.pos); this.pos += 2; }
  u16(v: number): void { this.align(2); this.ensure(2); this.buf.writeUInt16LE(v, this.pos); this.pos += 2; }
  i32(v: number): void { this.align(4); this.ensure(4); this.buf.writeInt32LE(v, this.pos); this.pos += 4; }
  u32(v: number): void { this.align(4); this.ensure(4); this.buf.writeUInt32LE(v >>> 0, this.pos); this.pos += 4; }
  i64(v: bigint | number): void { this.align(8); this.ensure(8); this.buf.writeBigInt64LE(BigInt(v), this.pos); this.pos += 8; }
  u64(v: bigint | number): void { this.align(8); this.ensure(8); this.buf.writeBigUInt64LE(BigInt(v), this.pos); this.pos += 8; }
  f64(v: number): void { this.align(8); this.ensure(8); this.buf.writeDoubleLE(v, this.pos); this.pos += 8; }
  string(s: string): void {
    const len = Buffer.byteLength(s);
    this.u32(len);
    this.ensure(len + 1);
    this.buf.write(s, this.pos, 'utf8');
    this.pos += len;
    this.buf[this.pos++] = 0;
  }
  signature(s: string): void {
    const len = Buffer.byteLength(s);
    if (len > 255) throw new Error('D-Bus signature too long');
    this.u8(len);
    this.ensure(len + 1);
    this.buf.write(s, this.pos, 'ascii');
    this.pos += len;
    this.buf[this.pos++] = 0;
  }
  toBuffer(): Buffer {
    return this.buf.subarray(0, this.pos);
  }
}

/** Guess a D-Bus signature for a plain JS value (used for variants given without a type). */
export function inferSignature(value: unknown): string {
  if (value instanceof Variant) return 'v';
  switch (typeof value) {
    case 'string': return 's';
    case 'boolean': return 'b';
    case 'bigint': return 'x';
    case 'number': return Number.isInteger(value) && Math.abs(value) < 2 ** 31 ? 'i' : 'd';
  }
  if (Array.isArray(value)) return 'av';
  if (value && typeof value === 'object') return 'a{sv}';
  throw new Error(`Cannot infer a D-Bus type for ${String(value)}`);
}

export function writeValue(w: Writer, type: TypeNode, value: unknown): void {
  switch (type.code) {
    case 'y': w.u8(Number(value)); return;
    case 'b': w.u32(value ? 1 : 0); return;
    case 'n': w.i16(Number(value)); return;
    case 'q': w.u16(Number(value)); return;
    case 'i': w.i32(Number(value)); return;
    case 'u': case 'h': w.u32(Number(value)); return;
    case 'x': w.i64(value as bigint | number); return;
    case 't': w.u64(value as bigint | number); return;
    case 'd': w.f64(Number(value)); return;
    case 's': case 'o': w.string(String(value)); return;
    case 'g': w.signature(String(value)); return;
    case 'v': {
      const variant = value instanceof Variant ? value : new Variant(inferSignature(value), value);
      const inner = parseSignature(variant.signature);
      if (inner.length !== 1) throw new Error(`Variant signature must be a single type: "${variant.signature}"`);
      w.signature(variant.signature);
      writeValue(w, inner[0], variant.value);
      return;
    }
    case '(': {
      const fields = value as unknown[];
      w.align(8);
      type.children.forEach((t, i) => writeValue(w, t, fields[i]));
      return;
    }
    case 'a': {
      const elem = type.children[0];
      w.u32(0);
      const lengthPos = w.pos - 4;
      w.align(alignmentOf(elem.code));
      const start = w.pos;
      if (elem.code === '{') {
        const entries = value instanceof Map ? [...value.entries()] : Object.entries(value as object);
        for (const [k, v] of entries) {
          w.align(8);
          writeValue(w, elem.children[0], k);
          writeValue(w, elem.children[1], v);
        }
      } else if (elem.code === 'y' && (value instanceof Uint8Array)) {
        for (const byte of value) w.u8(byte);
      } else {
        for (const item of value as unknown[]) writeValue(w, elem, item);
      }
      w.buf.writeUInt32LE(w.pos - start, lengthPos);
      return;
    }
    case '{':
      throw new Error('Dict entries may only appear inside arrays');
  }
}

export function marshal(signature: string, values: readonly unknown[]): Buffer {
  const types = parseSignature(signature);
  if (types.length !== values.length) {
    throw new Error(`Signature "${signature}" expects ${types.length} values, got ${values.length}`);
  }
  const w = new Writer();
  types.forEach((t, i) => writeValue(w, t, values[i]));
  return w.toBuffer();
}

// ---------------------------------------------------------------------------
// Reader

export class Reader {
  readonly buf: Buffer;
  pos: number;
  readonly little: boolean;
  /** Offset of the start of the message, for alignment purposes. */
  readonly base: number;
  constructor(buf: Buffer, pos = 0, little = true, base = 0) {
    this.buf = buf;
    this.pos = pos;
    this.little = little;
    this.base = base;
  }
  align(n: number): void {
    const rel = this.pos - this.base;
    this.pos += (n - (rel % n)) % n;
  }
  private check(n: number): void {
    if (this.pos + n > this.buf.length) throw new Error('D-Bus message truncated');
  }
  u8(): number { this.check(1); return this.buf[this.pos++]; }
  i16(): number { this.align(2); this.check(2); const v = this.little ? this.buf.readInt16LE(this.pos) : this.buf.readInt16BE(this.pos); this.pos += 2; return v; }
  u16(): number { this.align(2); this.check(2); const v = this.little ? this.buf.readUInt16LE(this.pos) : this.buf.readUInt16BE(this.pos); this.pos += 2; return v; }
  i32(): number { this.align(4); this.check(4); const v = this.little ? this.buf.readInt32LE(this.pos) : this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  u32(): number { this.align(4); this.check(4); const v = this.little ? this.buf.readUInt32LE(this.pos) : this.buf.readUInt32BE(this.pos); this.pos += 4; return v; }
  i64(): bigint { this.align(8); this.check(8); const v = this.little ? this.buf.readBigInt64LE(this.pos) : this.buf.readBigInt64BE(this.pos); this.pos += 8; return v; }
  u64(): bigint { this.align(8); this.check(8); const v = this.little ? this.buf.readBigUInt64LE(this.pos) : this.buf.readBigUInt64BE(this.pos); this.pos += 8; return v; }
  f64(): number { this.align(8); this.check(8); const v = this.little ? this.buf.readDoubleLE(this.pos) : this.buf.readDoubleBE(this.pos); this.pos += 8; return v; }
  string(): string {
    const len = this.u32();
    this.check(len + 1);
    const s = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len + 1;
    return s;
  }
  signature(): string {
    const len = this.u8();
    this.check(len + 1);
    const s = this.buf.toString('ascii', this.pos, this.pos + len);
    this.pos += len + 1;
    return s;
  }
}

/**
 * Read one value. Variants are unwrapped to their inner value; dicts with string-like keys
 * become plain objects and other dicts become Maps; structs become arrays.
 */
export function readValue(r: Reader, type: TypeNode): unknown {
  switch (type.code) {
    case 'y': return r.u8();
    case 'b': return r.u32() !== 0;
    case 'n': return r.i16();
    case 'q': return r.u16();
    case 'i': return r.i32();
    case 'u': case 'h': return r.u32();
    case 'x': return r.i64();
    case 't': return r.u64();
    case 'd': return r.f64();
    case 's': case 'o': return r.string();
    case 'g': return r.signature();
    case 'v': {
      const sig = r.signature();
      const inner = parseSignature(sig);
      if (inner.length !== 1) throw new Error(`Bad variant signature "${sig}"`);
      return readValue(r, inner[0]);
    }
    case '(': {
      r.align(8);
      return type.children.map((t) => readValue(r, t));
    }
    case 'a': {
      const len = r.u32();
      const elem = type.children[0];
      r.align(alignmentOf(elem.code));
      const end = r.pos + len;
      if (end > r.buf.length) throw new Error('D-Bus array overruns message');
      if (elem.code === '{') {
        const keyCode = elem.children[0].code;
        const stringKeys = keyCode === 's' || keyCode === 'o' || keyCode === 'g';
        const out: Record<string, unknown> | Map<unknown, unknown> = stringKeys ? Object.create(null) : new Map();
        while (r.pos < end) {
          r.align(8);
          const k = readValue(r, elem.children[0]);
          const v = readValue(r, elem.children[1]);
          if (out instanceof Map) out.set(k, v);
          else out[k as string] = v;
        }
        return out;
      }
      if (elem.code === 'y') {
        const bytes = Buffer.from(r.buf.subarray(r.pos, end));
        r.pos = end;
        return bytes;
      }
      const items: unknown[] = [];
      while (r.pos < end) items.push(readValue(r, elem));
      return items;
    }
    case '{':
      throw new Error('Dict entry outside of array');
  }
}

export function unmarshal(signature: string, buf: Buffer, little = true): unknown[] {
  const r = new Reader(buf, 0, little, 0);
  return parseSignature(signature).map((t) => readValue(r, t));
}

// ---------------------------------------------------------------------------
// Messages

export const MessageType = {
  MethodCall: 1,
  MethodReturn: 2,
  Error: 3,
  Signal: 4,
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const MessageFlags = {
  NoReplyExpected: 0x1,
  NoAutoStart: 0x2,
  AllowInteractiveAuthorization: 0x4,
} as const;

export interface Message {
  type: MessageType;
  flags?: number;
  serial?: number;
  path?: string;
  interface?: string;
  member?: string;
  errorName?: string;
  replySerial?: number;
  destination?: string;
  sender?: string;
  signature?: string;
  body?: unknown[];
}

const HEADER_FIELDS = {
  path: [1, 'o'],
  interface: [2, 's'],
  member: [3, 's'],
  errorName: [4, 's'],
  replySerial: [5, 'u'],
  destination: [6, 's'],
  sender: [7, 's'],
  signature: [8, 'g'],
} as const;

const FIELD_BY_CODE: Record<number, keyof typeof HEADER_FIELDS> = {
  1: 'path', 2: 'interface', 3: 'member', 4: 'errorName',
  5: 'replySerial', 6: 'destination', 7: 'sender', 8: 'signature',
};

export function encodeMessage(msg: Message, serial: number): Buffer {
  const signature = msg.signature ?? '';
  const body = signature ? marshal(signature, msg.body ?? []) : Buffer.alloc(0);
  const w = new Writer(128 + body.length);
  w.u8(0x6c); // 'l' little endian
  w.u8(msg.type);
  w.u8(msg.flags ?? 0);
  w.u8(1); // protocol version
  w.u32(body.length);
  w.u32(serial);
  // header fields: a(yv)
  w.u32(0);
  const lenPos = w.pos - 4;
  w.align(8);
  const start = w.pos;
  for (const key of Object.keys(HEADER_FIELDS) as (keyof typeof HEADER_FIELDS)[]) {
    const value = key === 'signature' ? (signature || undefined) : msg[key];
    if (value === undefined || value === null || value === '') continue;
    const [code, sig] = HEADER_FIELDS[key];
    w.align(8);
    w.u8(code);
    w.signature(sig);
    writeValue(w, parseSignature(sig)[0], value);
  }
  w.buf.writeUInt32LE(w.pos - start, lenPos);
  w.align(8);
  const header = w.toBuffer();
  return body.length ? Buffer.concat([header, body]) : Buffer.from(header);
}

/** Returns the total length of the message at the start of `buf`, or -1 if more bytes are needed. */
export function messageLength(buf: Buffer): number {
  if (buf.length < 16) return -1;
  const little = buf[0] === 0x6c;
  const bodyLen = little ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
  const fieldsLen = little ? buf.readUInt32LE(12) : buf.readUInt32BE(12);
  const headerLen = 16 + fieldsLen + ((8 - ((16 + fieldsLen) % 8)) % 8);
  const total = headerLen + bodyLen;
  return buf.length >= total ? total : -1;
}

export function decodeMessage(buf: Buffer): Message {
  const endian = buf[0];
  if (endian !== 0x6c && endian !== 0x42) throw new Error(`Bad D-Bus endianness marker ${endian}`);
  const little = endian === 0x6c;
  const r = new Reader(buf, 1, little, 0);
  const type = r.u8() as MessageType;
  const flags = r.u8();
  r.u8(); // version
  const bodyLen = r.u32();
  const serial = r.u32();
  const msg: Message = { type, flags, serial };
  const fieldsLen = r.u32();
  r.align(8);
  const end = r.pos + fieldsLen;
  while (r.pos < end) {
    r.align(8);
    const code = r.u8();
    const sig = r.signature();
    const value = readValue(r, parseSignature(sig)[0]);
    const key = FIELD_BY_CODE[code];
    if (key) (msg as unknown as Record<string, unknown>)[key] = value;
  }
  r.align(8);
  const bodyStart = r.pos;
  if (msg.signature) {
    const br = new Reader(buf.subarray(bodyStart, bodyStart + bodyLen), 0, little, 0);
    msg.body = parseSignature(msg.signature).map((t) => readValue(br, t));
  } else {
    msg.body = [];
  }
  return msg;
}
