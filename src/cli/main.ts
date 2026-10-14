// northbridge: drive desktop apps through their accessibility trees from the command line.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { READ_PROPERTIES, type ReadProperty, Session } from '../agent/session.ts';
import { connect } from '../connect.ts';
import type { Desktop } from '../desktop.ts';
import type { WaitState } from '../locator.ts';
import { RefRegistry } from '../refs.ts';

const HELP = `northbridge — use any desktop app through its accessibility tree

Usage: northbridge <command> [arguments] [options]

See what's there
  snapshot [target]          The screen as text: every app and window, the active window in
                             full, with a ref (e12) on each element. Give a target (ref or
                             selector) or --app to show just that.
      -i, --interactive          only things you can act on
      --all                      expand every window, not just the active one
      --hidden                   include things that aren't showing (closed menus, other tabs)
  apps                       Running apps and their windows
  find <selector>            Every element matching a selector, one per line
  get <target> [property]    Read ${READ_PROPERTIES.join('|')} (default: text)
  focused                    The element with keyboard focus
  wait <target>              Wait until it's visible (--state visible|hidden|attached|detached)
  screenshot [target]        PNG of the screen, an app (--app) or an element; -o <file>

Do things (each prints what it did and what changed)
  click <target>             --double, --right, --mouse (real pointer), --action (accessibility only)
  fill <target> <text>       Replace the text in a field
  type [target] <text>       Type key by key (into the focused element if no target); --submit
  press <keys...>            Enter, Tab, Control+s, ArrowDown … in order; --into <target> first
  check|uncheck <target>
  select <target> <option>   Pick an option in a combo box, list or tab list (#2 picks by index)
  set <target> <number>      Set a slider or spin button
  invoke <target> <action>   Run a named accessibility action
  hover|focus|expand|collapse|scroll-into-view <target>
  scroll [target]            Mouse wheel; --dy N (down, default 3), --dx N (right)
  mouse <op> <x> <y> …       Raw pointer input: click, double-click, move, down, up, drag x1 y1 x2 y2

Apps
  launch <command…>          Start an app and wait for its window (--name if it hands off to
                             another process, --no-wait); use -- before the app's own flags
  close <app>                Ask an app to quit

Agents and CI
  mcp                        Serve these tools over MCP (stdio)
  headless <command…>        Run a command in a throwaway desktop (Xvfb, D-Bus, AT-SPI), e.g.
                             northbridge headless -- npm test

Targets are refs from a snapshot (e12) or selectors that read like snapshot lines:
  'button "Save"'   '#submit'   'dialog "Confirm" >> button "OK"'   'checkbox [checked]'
  'textbox "Email"' 'listitem:has-text("Inbox")'   '"Save"' (any role)   '/regex/i' names

Options
  -a, --app <name>           Look for selectors inside this app (name, window title or pid)
  -t, --timeout <ms>         How long to wait for things (default 5000)
  -q, --quiet                Don't report what changed after an action
      --json                 Machine-readable output
  -h, --help, -v, --version

Refs persist between commands for as long as the accessibility session lives.`;

const OPTIONS = {
  app: { type: 'string', short: 'a' },
  timeout: { type: 'string', short: 't' },
  quiet: { type: 'boolean', short: 'q' },
  json: { type: 'boolean' },
  interactive: { type: 'boolean', short: 'i' },
  all: { type: 'boolean' },
  hidden: { type: 'boolean' },
  depth: { type: 'string' },
  output: { type: 'string', short: 'o' },
  double: { type: 'boolean' },
  right: { type: 'boolean' },
  middle: { type: 'boolean' },
  mouse: { type: 'boolean' },
  action: { type: 'boolean' },
  state: { type: 'string' },
  name: { type: 'string' },
  'no-wait': { type: 'boolean' },
  submit: { type: 'boolean' },
  into: { type: 'string' },
  dx: { type: 'string' },
  dy: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

class UsageError extends Error {}

function version(): string {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

function stateFile(sessionId: string): string {
  const base =
    process.env.NORTHBRIDGE_STATE_DIR ??
    join(process.env.XDG_RUNTIME_DIR ?? join(tmpdir(), `northbridge-${process.getuid?.() ?? 'user'}`), 'northbridge');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  return join(base, `refs-${sessionId.replace(/[^\w.-]/g, '_')}.json`);
}

function loadRefs(file: string): RefRegistry {
  try {
    return RefRegistry.fromJSON(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return new RefRegistry();
  }
}

function saveRefs(file: string, refs: RefRegistry): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(refs), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Run a command inside scripts/desktop.sh's throwaway desktop. */
function headless(command: string[]): Promise<number> {
  if (!command.length) {
    process.stderr.write('Usage: northbridge headless -- <command...>\n');
    return Promise.resolve(2);
  }
  const script = new URL('../../scripts/desktop.sh', import.meta.url);
  return new Promise((resolve) => {
    const child = spawn('bash', [script.pathname, ...command], { stdio: 'inherit' });
    child.on('error', (err) => {
      process.stderr.write(`Error: ${err.message}\n`);
      resolve(1);
    });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

function need(args: string[], count: number, usage: string): void {
  if (args.length < count) throw new UsageError(`Usage: northbridge ${usage}`);
}

function number(value: string | undefined, what: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new UsageError(`${what} must be a number, got "${value}"`);
  return n;
}

type Values = { [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]['type'] extends 'string' ? string : boolean };

async function run(session: Session, command: string, args: string[], v: Values) {
  const app = v.app;
  switch (command) {
    case 'snapshot':
      return session.snapshot({ target: args[0], app, interactive: v.interactive, all: v.all, hidden: v.hidden, depth: number(v.depth, '--depth') });
    case 'apps':
      return session.apps();
    case 'find':
      need(args, 1, 'find <selector>');
      return session.find(args[0], { app });
    case 'get':
    case 'read': {
      need(args, 1, 'get <target> [property]');
      const property = (args[1] ?? 'text') as ReadProperty;
      if (!READ_PROPERTIES.includes(property)) throw new UsageError(`Unknown property "${property}". One of: ${READ_PROPERTIES.join(', ')}`);
      return session.read(args[0], property, { app });
    }
    case 'focused':
      return session.focused();
    case 'wait': {
      need(args, 1, 'wait <target> [--state visible|hidden|attached|detached]');
      const state = (v.state ?? 'visible') as WaitState;
      if (!['visible', 'hidden', 'attached', 'detached'].includes(state)) throw new UsageError(`Unknown state "${state}"`);
      return session.wait(args[0], state, number(v.timeout, '--timeout'), { app });
    }
    case 'screenshot': {
      const path = v.output ?? `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      return session.screenshot(args[0], { app, path });
    }
    case 'click':
      need(args, 1, 'click <target>');
      return session.click(args[0], {
        app,
        double: v.double,
        button: v.right ? 'right' : v.middle ? 'middle' : 'left',
        method: v.mouse ? 'mouse' : v.action ? 'action' : 'auto',
      });
    case 'fill':
      need(args, 2, 'fill <target> <text>');
      return session.fill(args[0], args[1], { app });
    case 'type':
      need(args, 1, 'type [target] <text>');
      return args.length === 1 ? session.type(undefined, args[0], { submit: v.submit }) : session.type(args[0], args[1], { app, submit: v.submit });
    case 'press':
      need(args, 1, 'press <keys...> [--into <target>]');
      return session.press(args, v.into, { app });
    case 'check':
    case 'uncheck':
      need(args, 1, `${command} <target>`);
      return session.check(args[0], command === 'check', { app });
    case 'select':
      need(args, 2, 'select <target> <option>');
      return session.select(args[0], args[1], { app });
    case 'set': {
      need(args, 2, 'set <target> <number>');
      return session.setValue(args[0], number(args[1], 'The value')!, { app });
    }
    case 'invoke':
      need(args, 2, 'invoke <target> <action>');
      return session.invoke(args[0], args[1], { app });
    case 'hover':
      need(args, 1, 'hover <target>');
      return session.hover(args[0], { app });
    case 'focus':
      need(args, 1, 'focus <target>');
      return session.focus(args[0], { app });
    case 'expand':
    case 'collapse':
      need(args, 1, `${command} <target>`);
      return session.expand(args[0], command === 'expand', { app });
    case 'scroll-into-view':
      need(args, 1, 'scroll-into-view <target>');
      return session.scrollIntoView(args[0], { app });
    case 'scroll':
      return session.scroll(args[0], number(v.dx, '--dx') ?? 0, number(v.dy, '--dy') ?? (v.dx ? 0 : 3), { app });
    case 'mouse': {
      need(args, 1, 'mouse <click|double-click|move|down|up|drag> [x y ...]');
      const [op, ...coords] = args;
      const nums = coords.map((c) => number(c, 'Coordinates')!);
      return session.mouse(op as Parameters<Session['mouse']>[0], nums, v.right ? 'right' : v.middle ? 'middle' : 'left');
    }
    case 'launch':
      need(args, 1, 'launch <command...>');
      return session.launch(args, { name: v.name, wait: !v['no-wait'] });
    case 'close':
      need(args, 1, 'close <app>');
      return session.close(args[0]);
    default:
      throw new UsageError(`Unknown command "${command}". Run northbridge --help for the list.`);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }) as typeof parsed;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\nRun northbridge --help for usage.\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...args] = positionals;
  if (values.version) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  if (values.help || !command || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return command || values.help ? 0 : 2;
  }
  if (command === 'mcp') {
    const { serve } = await import('../mcp/server.ts');
    await serve({ version: version() });
    return 0;
  }
  if (command === 'headless') return headless(args);

  let desktop: Desktop | undefined;
  let file: string | undefined;
  try {
    const refs = new RefRegistry();
    desktop = await connect({ refs, timeout: number(values.timeout, '--timeout') });
    file = stateFile(desktop.backend.sessionId);
    refs.merge(loadRefs(file));
    const session = new Session(desktop, { trackChanges: !values.quiet });
    const result = await run(session, command, args, values);
    const data = 'data' in result ? (result.data as object) : {};
    if (values.json) process.stdout.write(`${JSON.stringify({ ok: true, ...data, text: result.text })}\n`);
    else process.stdout.write(`${result.text}\n`);
    return 0;
  } catch (err) {
    const message = Session.describeError(err);
    if (values.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message, type: (err as Error)?.name })}\n`);
    else process.stderr.write(`${err instanceof UsageError ? '' : 'Error: '}${message}\n`);
    return err instanceof UsageError ? 2 : 1;
  } finally {
    if (desktop && file) {
      try {
        saveRefs(file, desktop.refs);
      } catch {}
    }
    await desktop?.close().catch(() => {});
  }
}
