// The commands behind the CLI and the MCP server. Each returns text written for whoever is
// driving: what was done, to which element, and what changed on screen as a result.

import { writeFile } from 'node:fs/promises';
import type { App } from '../app.ts';
import type { MouseButton, NodeHandle } from '../backend.ts';
import type { Desktop } from '../desktop.ts';
import type { ClickOptions, Element } from '../element.ts';
import { NorthbridgeError, StaleElementError } from '../errors.ts';
import type { Locator, WaitState } from '../locator.ts';
import { RefRegistry } from '../refs.ts';
import { renderSnapshot } from '../snapshot.ts';
import { DESKTOP, walk } from '../tree.ts';
import { sleep } from '../util.ts';
import { diffSnapshots } from './changes.ts';

export interface CommandResult {
  text: string;
  /** PNG bytes, for screenshots. */
  image?: Buffer;
  /** Structured result for --json and programmatic use. */
  data?: unknown;
}

export interface TargetOptions {
  /** Look for the selector inside this app (name, window title, or pid). */
  app?: string;
}

export interface SnapshotCommand extends TargetOptions {
  target?: string;
  interactive?: boolean;
  all?: boolean;
  hidden?: boolean;
  depth?: number;
}

export type ReadProperty =
  | 'text' | 'name' | 'value' | 'states' | 'role' | 'description' | 'id' | 'bounds' | 'actions' | 'attributes' | 'describe';

export const READ_PROPERTIES: ReadProperty[] = [
  'text', 'name', 'value', 'states', 'role', 'description', 'id', 'bounds', 'actions', 'attributes', 'describe',
];

export class Session {
  readonly desktop: Desktop;
  /** Report what changed after each action. */
  trackChanges: boolean;

  constructor(desktop: Desktop, options: { trackChanges?: boolean } = {}) {
    this.desktop = desktop;
    this.trackChanges = options.trackChanges ?? true;
  }

  // ---------------------------------------------------------------------------------------------
  // Targets

  private async findApp(app: string): Promise<App> {
    const pid = /^\d+$/.test(app) ? Number(app) : undefined;
    return this.desktop.app(pid !== undefined ? { pid } : app);
  }

  /** A ref ("e12") or a selector (`button "Save"`), optionally inside one app. */
  async locate(target: string, options: TargetOptions = {}): Promise<Locator> {
    if (RefRegistry.isRef(target)) return this.desktop.locator(`@${RefRegistry.normalize(target)}`);
    if (options.app) return (await this.findApp(options.app)).locator(target);
    return this.desktop.locator(target);
  }

  private async snapshotOf(root: NodeHandle): Promise<string | null> {
    const tree = await walk(this.desktop.backend, root);
    return tree ? renderSnapshot(tree, this.desktop.refs) : null;
  }

  /** Snapshot again until two in a row agree (or ~1.5s pass), so effects have landed. */
  private async settledSnapshotOf(root: NodeHandle): Promise<string | null> {
    const deadline = Date.now() + 1500;
    let previous: string | null | undefined;
    await sleep(60);
    for (;;) {
      const current = await this.snapshotOf(root).catch(() => null);
      if (current === null || current === previous || Date.now() >= deadline) return current;
      previous = current;
      await sleep(120);
    }
  }

  /** Run an action on a target and describe it, plus what changed in the target's app. */
  private async act(locator: Locator, verb: string, run: (el: Element) => Promise<void>): Promise<CommandResult> {
    const element = await locator.element();
    const description = await element.describe();
    const root = this.desktop.backend.appOf(element.handle);
    const before = this.trackChanges ? await this.snapshotOf(root).catch(() => null) : null;
    await run(element);
    let text = `${verb} ${description}`;
    let changes: ReturnType<typeof diffSnapshots> | undefined;
    if (before !== null) {
      const after = await this.settledSnapshotOf(root);
      if (after === null) text += '\nThe app closed.';
      else {
        changes = diffSnapshots(before, after);
        text += changes.text ? `\n${changes.text}` : '\nNo visible changes.';
      }
    }
    return { text, data: { action: verb, target: description, changes: changes?.text ?? null } };
  }

  /** Like act(), for input that goes wherever focus is: report changes in the active window's app. */
  private async actOnFocus(verb: string, run: () => Promise<void>): Promise<CommandResult> {
    const window = this.trackChanges ? await this.desktop.activeWindow().catch(() => null) : null;
    const root = window ? this.desktop.backend.appOf(window.handle) : null;
    const before = root ? await this.snapshotOf(root).catch(() => null) : null;
    await run();
    if (!root || before === null) return { text: verb };
    const after = await this.settledSnapshotOf(root);
    if (after === null) return { text: `${verb}\nThe app closed.` };
    const changes = diffSnapshots(before, after);
    return { text: `${verb}\n${changes.text || 'No visible changes.'}`, data: { action: verb, changes: changes.text } };
  }

  // ---------------------------------------------------------------------------------------------
  // Seeing

  async snapshot(command: SnapshotCommand = {}): Promise<CommandResult> {
    const options = { interactive: command.interactive, includeHidden: command.hidden, depth: command.depth };
    let text: string;
    if (command.target) text = await (await this.locate(command.target, command)).snapshot(options);
    else if (command.app) text = await (await this.findApp(command.app)).snapshot(options);
    else text = await this.desktop.snapshot({ ...options, all: command.all });
    return { text: text || '(nothing on screen exposes an accessibility tree)', data: { snapshot: text } };
  }

  /** Running apps and their windows. */
  async apps(): Promise<CommandResult> {
    const tree = await walk(this.desktop.backend, DESKTOP, { maxDepth: 2, text: false, values: false, labels: false });
    if (!tree) return { text: '', data: { apps: [] } };
    for (const app of tree.children) for (const w of app.children) w.unexpanded = false;
    const pids = new Map<string, number | undefined>();
    await Promise.all(tree.children.map(async (a) => pids.set(a.handle.key, await this.desktop.backend.pidOf(a.handle))));
    const text = renderSnapshot(tree, this.desktop.refs, {
      annotate: (n) => (pids.get(n.handle.key) ? [`pid=${pids.get(n.handle.key)}`] : []),
    });
    const data = tree.children.map((a) => ({
      name: a.name,
      pid: pids.get(a.handle.key),
      ref: this.desktop.refs.refFor(a.handle.key),
      windows: a.children.map((w) => ({ role: w.info.role, name: w.name, ref: this.desktop.refs.refFor(w.handle.key) })),
    }));
    return { text: text || '(no apps expose an accessibility tree)', data: { apps: data } };
  }

  /** Every element matching a selector, one line each. */
  async find(selector: string, options: TargetOptions = {}): Promise<CommandResult> {
    const locator = await this.locate(selector, options);
    const elements = await locator.all();
    const lines = await Promise.all(elements.map((e) => e.describe().catch(() => null)));
    const found = lines.filter((l): l is string => l !== null);
    return { text: found.length ? found.map((l) => `- ${l}`).join('\n') : `No elements match ${locator}`, data: { matches: found } };
  }

  async read(target: string, property: ReadProperty = 'text', options: TargetOptions = {}): Promise<CommandResult> {
    const locator = await this.locate(target, options);
    let value: unknown;
    switch (property) {
      case 'text': value = await locator.text(); break;
      case 'name': value = await locator.name(); break;
      case 'value': value = await locator.value(); break;
      case 'states': value = await locator.states(); break;
      case 'role': value = await locator.role(); break;
      case 'description': value = await locator.description(); break;
      case 'id': value = await locator.id(); break;
      case 'bounds': value = await locator.bounds(); break;
      case 'actions': value = await locator.actions(); break;
      case 'attributes': value = await locator.attributes(); break;
      case 'describe': value = await locator.describe(); break;
      default: throw new NorthbridgeError(`Can't read "${property}". Try one of: ${READ_PROPERTIES.join(', ')}`);
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, Array.isArray(value) ? undefined : 2);
    return { text: text ?? 'null', data: { [property]: value } };
  }

  async wait(target: string, state: WaitState = 'visible', timeout?: number, options: TargetOptions = {}): Promise<CommandResult> {
    const locator = await this.locate(target, options);
    await locator.waitFor({ state, timeout });
    if (state === 'visible' || state === 'attached') {
      const description = await locator.describe({ timeout: 0 }).catch(() => String(locator));
      return { text: `${state}: ${description}`, data: { state, target: description } };
    }
    return { text: `${state}: ${locator}`, data: { state, target: String(locator) } };
  }

  async focused(): Promise<CommandResult> {
    const el = await this.desktop.focused();
    if (!el) return { text: 'Nothing has keyboard focus.', data: { focused: null } };
    const description = await el.describe();
    return { text: description, data: { focused: description } };
  }

  async screenshot(target?: string, options: TargetOptions & { path?: string } = {}): Promise<CommandResult> {
    const png = target
      ? await (await this.locate(target, options)).screenshot()
      : options.app
        ? await (await (await this.findApp(options.app)).window().first().element()).screenshot()
        : await this.desktop.screenshot();
    if (options.path) await writeFile(options.path, png);
    return {
      text: options.path ? `Saved ${png.length} bytes to ${options.path}` : `Captured ${png.length} bytes of PNG`,
      image: png,
      data: options.path ? { path: options.path, bytes: png.length } : { bytes: png.length },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Doing

  async click(target: string, options: TargetOptions & { double?: boolean; button?: MouseButton; method?: ClickOptions['method'] } = {}) {
    const locator = await this.locate(target, options);
    const verb = options.double ? 'Double-clicked' : options.button === 'right' ? 'Right-clicked' : 'Clicked';
    return this.act(locator, verb, (el) =>
      el.click({ clickCount: options.double ? 2 : 1, button: options.button, method: options.method }),
    );
  }

  async fill(target: string, text: string, options: TargetOptions = {}) {
    return this.act(await this.locate(target, options), 'Filled', (el) => el.fill(text));
  }

  /** Type into a target, or into whatever has focus when there's no target. */
  async type(target: string | undefined, text: string, options: TargetOptions & { submit?: boolean } = {}) {
    if (!target) {
      return this.actOnFocus(`Typed ${JSON.stringify(text)}${options.submit ? ' and pressed Enter' : ''}`, async () => {
        await this.desktop.keyboard.type(text);
        if (options.submit) await this.desktop.keyboard.press('Enter');
      });
    }
    return this.act(await this.locate(target, options), 'Typed into', async (el) => {
      await el.type(text);
      if (options.submit) await el.press('Enter');
    });
  }

  /** Press keys in order ("Tab", "Control+s"); focus a target first if given. */
  async press(keys: string[], target?: string, options: TargetOptions = {}) {
    if (!target) {
      return this.actOnFocus(`Pressed ${keys.join(', ')}`, async () => {
        for (const key of keys) await this.desktop.keyboard.press(key);
      });
    }
    return this.act(await this.locate(target, options), `Pressed ${keys.join(', ')} in`, async (el) => {
      for (const key of keys) await el.press(key);
    });
  }

  async check(target: string, checked = true, options: TargetOptions = {}) {
    return this.act(await this.locate(target, options), checked ? 'Checked' : 'Unchecked', (el) => el.setChecked(checked));
  }

  async select(target: string, option: string, options: TargetOptions = {}) {
    const choice = /^#\d+$/.test(option) ? { index: Number(option.slice(1)) } : option;
    return this.act(await this.locate(target, options), `Selected ${JSON.stringify(option)} in`, (el) => el.selectOption(choice));
  }

  async setValue(target: string, value: number, options: TargetOptions = {}) {
    return this.act(await this.locate(target, options), `Set ${value} on`, (el) => el.setValue(value));
  }

  async invoke(target: string, action: string, options: TargetOptions = {}) {
    return this.act(await this.locate(target, options), `Ran "${action}" on`, (el) => el.invoke(action));
  }

  async hover(target: string, options: TargetOptions = {}) {
    return this.act(await this.locate(target, options), 'Hovered over', (el) => el.hover());
  }

  async focus(target: string, options: TargetOptions = {}) {
    return this.act(await this.locate(target, options), 'Focused', (el) => el.focus());
  }

  async expand(target: string, expanded = true, options: TargetOptions = {}) {
    return this.act(await this.locate(target, options), expanded ? 'Expanded' : 'Collapsed', (el) => (expanded ? el.expand() : el.collapse()));
  }

  /** Scroll with the wheel over a target (or wherever the pointer is): positive dy scrolls down. */
  async scroll(target: string | undefined, dx: number, dy: number, options: TargetOptions = {}) {
    if (!target) {
      await this.desktop.mouse.wheel(dx, dy);
      return { text: `Scrolled ${dx}, ${dy}` };
    }
    return this.act(await this.locate(target, options), `Scrolled ${dx}, ${dy} over`, async (el) => {
      await el.hover();
      await this.desktop.mouse.wheel(dx, dy);
    });
  }

  async scrollIntoView(target: string, options: TargetOptions = {}) {
    return this.act(await this.locate(target, options), 'Scrolled into view', (el) => el.scrollIntoView());
  }

  /** Raw mouse input at screen coordinates, for things the tree doesn't describe. */
  async mouse(op: 'click' | 'double-click' | 'move' | 'down' | 'up' | 'drag', args: number[], button: MouseButton = 'left') {
    const mouse = this.desktop.mouse;
    const [x, y, x2, y2] = args;
    const need = (n: number) => {
      if (args.length < n || args.slice(0, n).some((v) => !Number.isFinite(v))) throw new NorthbridgeError(`mouse ${op} needs ${n} numbers`);
    };
    switch (op) {
      case 'click': need(2); await mouse.click(x, y, { button }); break;
      case 'double-click': need(2); await mouse.click(x, y, { button, clickCount: 2 }); break;
      case 'move': need(2); await mouse.move(x, y); break;
      case 'down': await mouse.down({ button }); break;
      case 'up': await mouse.up({ button }); break;
      case 'drag': need(4); await mouse.drag({ x, y }, { x: x2, y: y2 }, { button }); break;
      default: throw new NorthbridgeError(`Unknown mouse operation "${op}"`);
    }
    return { text: `mouse ${op} ${args.join(' ')}`.trim() };
  }

  // ---------------------------------------------------------------------------------------------
  // Apps

  async launch(command: string[], options: { name?: string; wait?: boolean } = {}): Promise<CommandResult> {
    const app = await this.desktop.launch(command, { detached: true, name: options.name, waitForWindow: options.wait !== false });
    const header = `Launched ${app.name}${app.pid ? ` (pid ${app.pid})` : ''}`;
    const snapshot = options.wait === false ? '' : await app.snapshot().catch(() => '');
    return { text: snapshot ? `${header}\n${snapshot}` : header, data: { name: app.name, pid: app.pid, snapshot } };
  }

  async close(app: string): Promise<CommandResult> {
    const found = await this.findApp(app);
    await found.close();
    return { text: `Closed ${found.name}${found.pid ? ` (pid ${found.pid})` : ''}` };
  }

  /** Describe an error for whoever is driving, keeping the useful listings intact. */
  static describeError(err: unknown): string {
    if (err instanceof StaleElementError) return `${err.message}. Take a new snapshot to get fresh refs.`;
    if (err instanceof Error) return err.message;
    return String(err);
  }
}

