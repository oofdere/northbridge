import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeMessage,
  encodeMessage,
  marshal,
  MessageType,
  messageLength,
  parseSignature,
  unmarshal,
  Variant,
} from '../../src/dbus/wire.ts';
import { parseAddress } from '../../src/dbus/connection.ts';

test('parses nested signatures', () => {
  const [t] = parseSignature('a((so)(so)(so)iiassusau)');
  assert.equal(t.code, 'a');
  assert.equal(t.children[0].code, '(');
  assert.equal(t.children[0].children.length, 10);
  assert.equal(t.children[0].children[0].signature, '(so)');
  assert.deepEqual(
    parseSignature('sa{sv}ai').map((n) => n.signature),
    ['s', 'a{sv}', 'ai'],
  );
  assert.throws(() => parseSignature('a{sv'));
  assert.throws(() => parseSignature('(s'));
});

test('round-trips basic types with correct alignment', () => {
  const values = [7, true, -3, 65000, -100000, 4000000000, -5n, 18446744073709551615n, 3.5, 'héllo', '/org/a', 'a{sv}'];
  const buf = marshal('ybnqiuxtdsog', values);
  assert.deepEqual(unmarshal('ybnqiuxtdsog', buf), values);
  // y (1) pad to 4, b (4) -> 8, n (2) q (2) -> 12, i -> 16, u -> 20, pad -> 24, x -> 32, t -> 40, d -> 48
  assert.equal(buf.readDoubleLE(40), 3.5);
});

test('round-trips containers', () => {
  const sig = 'a(so)a{sv}a{ss}(ia{us})ay';
  const values = [
    [[':1.2', '/a/b'], [':1.3', '/c']],
    { Name: 'x', Count: 3, Flag: false },
    { k: 'v' },
    [1, new Map([[5, 'five']])],
    Buffer.from([1, 2, 3]),
  ];
  const input = [
    values[0],
    { Name: new Variant('s', 'x'), Count: new Variant('i', 3), Flag: new Variant('b', false) },
    values[2],
    values[3],
    values[4],
  ];
  const out = unmarshal(sig, marshal(sig, input));
  assert.deepEqual(out[0], values[0]);
  assert.deepEqual({ ...(out[1] as object) }, values[1]);
  assert.deepEqual({ ...(out[2] as object) }, values[2]);
  assert.deepEqual(out[3], values[3]);
  assert.deepEqual(out[4], values[4]);
});

test('empty arrays still align to their element type', () => {
  // u32 length then padding to 8 for struct elements, even when empty
  const buf = marshal('ya(xx)y', [1, [], 2]);
  assert.equal(buf.length, 9);
  assert.deepEqual(unmarshal('ya(xx)y', buf), [1, [], 2]);
});

test('variants infer simple types', () => {
  const out = unmarshal('vvvv', marshal('vvvv', ['s', 42, true, 1.5]));
  assert.deepEqual(out, ['s', 42, true, 1.5]);
});

test('encodes and decodes whole messages', () => {
  const buf = encodeMessage(
    {
      type: MessageType.MethodCall,
      destination: 'org.a11y.atspi.Registry',
      path: '/org/a11y/atspi/accessible/root',
      interface: 'org.a11y.atspi.Accessible',
      member: 'GetChildAtIndex',
      signature: 'i',
      body: [3],
    },
    42,
  );
  assert.equal(messageLength(buf), buf.length);
  assert.equal(messageLength(buf.subarray(0, buf.length - 1)), -1);
  const msg = decodeMessage(buf);
  assert.equal(msg.serial, 42);
  assert.equal(msg.member, 'GetChildAtIndex');
  assert.equal(msg.destination, 'org.a11y.atspi.Registry');
  assert.deepEqual(msg.body, [3]);
});

test('decodes big-endian messages', () => {
  // Hand-built big-endian METHOD_RETURN with reply serial 9 and body "s" = "hi".
  const header = Buffer.from([
    0x42, 2, 0, 1,
    0, 0, 0, 7, // body length
    0, 0, 0, 5, // serial
    0, 0, 0, 0x0f, // fields array length = 15
    5, 1, 0x75, 0, 0, 0, 0, 9, // REPLY_SERIAL: u 9
    8, 1, 0x67, 0, 1, 0x73, 0, // SIGNATURE: g "s"
    0, // pad to 8
  ]);
  const body = Buffer.from([0, 0, 0, 2, 0x68, 0x69, 0]);
  const msg = decodeMessage(Buffer.concat([header, body]));
  assert.equal(msg.type, MessageType.MethodReturn);
  assert.equal(msg.replySerial, 9);
  assert.deepEqual(msg.body, ['hi']);
});

test('parses bus addresses', () => {
  assert.deepEqual(parseAddress('unix:path=/tmp/a%20b,guid=123;tcp:host=h,port=5'), [
    { transport: 'unix', params: { path: '/tmp/a b', guid: '123' } },
    { transport: 'tcp', params: { host: 'h', port: '5' } },
  ]);
});
