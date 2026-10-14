// The CLI as an agent uses it: one process per command, refs carried between them.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { GTK3_FIXTURE, PYTHON } from './fixture.ts';

const BIN = fileURLToPath(new URL('../../src/cli/bin.ts', import.meta.url));
const run = promisify(execFile);

async function nb(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args]);
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout: string; stderr: string; code: number };
    return { stdout: e.stdout, stderr: e.stderr, code: e.code };
  }
}

after(async () => {
  await nb('close', 'gtk3_app.py');
});

test('launch prints the app; refs work in later commands', async () => {
  const launched = await nb('launch', '--', PYTHON, GTK3_FIXTURE);
  assert.equal(launched.code, 0, launched.stderr);
  assert.match(launched.stdout, /^Launched gtk3_app\.py \(pid \d+\)/);
  const submit = /button "Submit" \[id="submit"\] \[ref=(e\d+)\]/.exec(launched.stdout)?.[1];
  const name = /textbox "Name" \[id="name-field"\] \[ref=(e\d+)\]/.exec(launched.stdout)?.[1];
  assert.ok(submit && name);

  const filled = await nb('fill', name, 'Katherine Johnson');
  assert.equal(filled.code, 0, filled.stderr);
  assert.match(filled.stdout, /: "Katherine Johnson"/);

  const clicked = await nb('click', submit);
  assert.match(clicked.stdout, /~ text "Submitted: name=Katherine Johnson;/);

  const read = await nb('get', '#status');
  assert.match(read.stdout, /^Submitted: name=Katherine Johnson;/);
});

test('json output', async () => {
  const result = await nb('get', '#status', 'states', '--json');
  const data = JSON.parse(result.stdout);
  assert.equal(data.ok, true);
  assert.ok(data.states.includes('showing'));
});

test('failures exit non-zero with the reason on stderr', async () => {
  const result = await nb('click', 'button "Nope"', '--timeout', '200');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^Error: Timed out after 200ms/);
  const usage = await nb('fill', 'only-one-arg');
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /Usage: northbridge fill/);
});

test('help', async () => {
  const help = await nb('--help');
  assert.equal(help.code, 0);
  assert.match(help.stdout, /snapshot \[target\]/);
});
