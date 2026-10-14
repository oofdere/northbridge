// Talk to `northbridge mcp` the way an MCP client does: JSON-RPC over stdio.
import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GTK3_FIXTURE, PYTHON } from './fixture.ts';

const BIN = fileURLToPath(new URL('../../src/cli/bin.ts', import.meta.url));

let server: ChildProcessWithoutNullStreams;
let nextId = 1;
const waiting = new Map<number, (msg: any) => void>();

function request(method: string, params: object = {}): Promise<any> {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function call(name: string, args: object = {}): Promise<{ text: string; isError: boolean; content: any[] }> {
  const msg = await request('tools/call', { name, arguments: args });
  assert.ok(msg.result, `tools/call ${name} failed: ${JSON.stringify(msg.error)}`);
  const text = msg.result.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
  return { text, isError: !!msg.result.isError, content: msg.result.content };
}

before(() => {
  server = spawn(process.execPath, [BIN, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  createInterface({ input: server.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
});

after(async () => {
  await call('close_app', { app: 'gtk3_app.py' }).catch(() => {});
  server.stdin.end();
  await new Promise((resolve) => server.once('exit', resolve));
});

test('initialize negotiates a protocol version and explains the workflow', async () => {
  const msg = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(msg.result.protocolVersion, '2025-06-18');
  assert.equal(msg.result.serverInfo.name, 'northbridge');
  assert.ok(msg.result.capabilities.tools);
  assert.match(msg.result.instructions, /snapshot/);
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
});

test('lists tools with schemas', async () => {
  const msg = await request('tools/list');
  const names = msg.result.tools.map((t: any) => t.name);
  for (const name of ['snapshot', 'click', 'fill', 'type', 'press_keys', 'select_option', 'launch_app', 'screenshot']) {
    assert.ok(names.includes(name), `missing tool ${name}`);
  }
  for (const tool of msg.result.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 20);
  }
});

test('launch, act by ref, see the changes', async () => {
  const launched = await call('launch_app', { command: [PYTHON, GTK3_FIXTURE] });
  assert.equal(launched.isError, false, launched.text);
  const ref = /textbox "Email" \[ref=(e\d+)\]/.exec(launched.text)?.[1];
  assert.ok(ref, launched.text);

  const filled = await call('fill', { target: ref, text: 'grace@example.com' });
  assert.match(filled.text, /^Filled textbox "Email"/);
  assert.match(filled.text, /~ textbox "Email" \[ref=e\d+\]: "grace@example.com"/);

  const clicked = await call('click', { target: 'button "Delete…"', app: 'gtk3_app.py' });
  assert.match(clicked.text, /\+ alert "Question" \[modal\]/);
  const cancel = await call('click', { target: 'alert >> button "Cancel"' });
  assert.match(cancel.text, /~ text "Kept"/);
  assert.match(cancel.text, /- alert "Question"/);
});

test('errors come back as tool errors with guidance', async () => {
  const result = await call('click', { target: 'button "Nope"', app: 'gtk3_app.py' });
  assert.equal(result.isError, true);
  assert.match(result.text, /Timed out .* button "Nope"/);
  const bad = await call('click', { target: 'buton "Save"' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Unknown role "buton"/);
});

test('screenshots are images', async () => {
  const shot = await call('screenshot', { app: 'gtk3_app.py' });
  const image = shot.content.find((c) => c.type === 'image');
  assert.equal(image.mimeType, 'image/png');
  assert.equal(Buffer.from(image.data, 'base64').subarray(1, 4).toString(), 'PNG');
});

test('unknown methods and tools are errors', async () => {
  const msg = await request('nope/nope');
  assert.equal(msg.error.code, -32601);
  const tool = await request('tools/call', { name: 'nope', arguments: {} });
  assert.equal(tool.error.code, -32602);
});
