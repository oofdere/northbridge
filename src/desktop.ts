// The entry point: a connection to the desktop's accessibility tree.

import { type ChildProcess, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { App } from './app.ts';
import type { AppHandle, Backend, InputDriver, NodeHandle } from './backend.ts';
import { Element } from './element.ts';
import { NorthbridgeError, NotSupportedError, TimeoutError } from './errors.ts';
import { Keyboard, Mouse } from './input.ts';
import { Locator, type ByRoleOptions, type RoleLike, type TextOptions } from './locator.ts';
import { type Rect, type State, WINDOW_ROLES } from './model.ts';
import { encodePng } from './png.ts';
import { isDescendantOf, processName, splitCommand } from './process.ts';
import { RefRegistry } from './refs.ts';
import { renderSnapshot, type SnapshotOptions } from './snapshot.ts';
import { DESKTOP, selfAndDescendants, type TreeNode, walk } from './tree.ts';
import { normalizeText, pollIntervals, sleep } from './util.ts';

export type AppMatch = string | RegExp | { name?: string | RegExp; pid?: number };

export interface LaunchOptions {
  /** Extra environment variables. Accessibility switches for common toolkits are set for you. */
  env?: Record<string, string>;
  cwd?: string;
  /** How long to wait for the app to appear, in ms. Default 20000. */
  timeout?: number;
  /** Identify the app by name instead of process id (for launchers that hand off to another process). */
  name?: string | RegExp;
  /** Wait until the app shows a window. Default true. */
  waitForWindow?: boolean;
  /** Keep the app running after this process exits or the desktop is closed. Default false. */
  detached?: boolean;
}

export interface DesktopSnapshotOptions extends SnapshotOptions {
  /** Expand every window, not just the active one. */
  all?: boolean;
  includeHidden?: boolean;
}

export interface ScreenshotOptions {
  /** Write the PNG here as well as returning it. */
  path?: string;
  /** Capture just this rectangle (screen coordinates). */
  clip?: Rect;
}

export class Desktop {
  readonly backend: Backend;
  /** Short names (e12) for elements, stable for the life of this connection. */
  readonly refs: RefRegistry;
  readonly keyboard: Keyboard;
  readonly mouse: Mouse;
  /** Default timeout in ms for auto-waiting actions, waits and assertions. */
  timeout = 5000;
  private readonly launched = new Set<App>();

  constructor(backend: Backend, options: { refs?: RefRegistry; timeout?: number } = {}) {
    this.backend = backend;
    this.refs = options.refs ?? new RefRegistry();
    if (options.timeout !== undefined) this.timeout = options.timeout;
    const driver = () => this.inputDriver();
    this.keyboard = new Keyboard(driver);
    this.mouse = new Mouse(driver);
  }

  setDefaultTimeout(ms: number): void {
    this.timeout = ms;
  }

  hasInput(): boolean {
    return this.backend.input !== undefined;
  }

  /** @internal */
  inputDriver(): InputDriver {
    if (!this.backend.input) throw this.noInputError('send keyboard or mouse input');
    return this.backend.input;
  }

  /** @internal */
  noInputError(what: string): NotSupportedError {
    return new NotSupportedError(
      `Can't ${what}: no input synthesis is available on this display (northbridge supports X11 today; ` +
        'Wayland compositors don\'t allow it yet). Accessibility actions still work: click(), fill(), check(), selectOption(), setValue().',
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Apps

  /** Every application exposing an accessibility tree. */
  async apps(): Promise<App[]> {
    return (await this.backend.apps()).map((a) => this.toApp(a));
  }

  private toApp(a: AppHandle, child?: ChildProcess): App {
    return new App(this, a.node, a.name, a.pid, child);
  }

  /** The App a node belongs to. */
  async appFor(handle: NodeHandle): Promise<App> {
    const root = this.backend.appOf(handle);
    const known = (await this.backend.apps()).find((a) => a.node.key === root.key);
    if (known) return this.toApp(known);
    const info = await this.backend.info(root);
    return new App(this, root, info.name, await this.backend.pidOf(root));
  }

  /**
   * Find a running app by name (its accessible name, process name, or a window title — exact
   * matches win over partial ones), by RegExp, or by `{ pid }`. Waits for it to appear.
   */
  async app(match: AppMatch, options: { timeout?: number } = {}): Promise<App> {
    const timeout = options.timeout ?? this.timeout;
    const deadline = Date.now() + timeout;
    let seen: AppHandle[] = [];
    for (const interval of pollIntervals()) {
      if (interval) await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
      seen = await this.backend.apps();
      const found = await this.matchApps(seen, match);
      if (found) return this.toApp(found);
      if (Date.now() >= deadline) break;
    }
    const names = seen.map((a) => `${JSON.stringify(a.name)}${a.pid ? ` (pid ${a.pid})` : ''}`).join(', ');
    throw new TimeoutError(`Timed out after ${timeout}ms waiting for app ${describeMatch(match)}. Running apps: ${names || 'none'}`);
  }

  private async matchApps(apps: AppHandle[], match: AppMatch): Promise<AppHandle | undefined> {
    if (typeof match === 'object' && !(match instanceof RegExp)) {
      return apps.find((a) => (match.pid === undefined || a.pid === match.pid) && (match.name === undefined || nameMatches(match.name, [a.name], 'exact')));
    }
    const titles = await Promise.all(apps.map((a) => this.windowTitles(a.node)));
    const candidates = apps.map((a, i) => [a.name, a.pid ? processName(a.pid) ?? '' : '', ...titles[i]]);
    if (match instanceof RegExp) return apps.find((_, i) => nameMatches(match, candidates[i], 'exact'));
    const exact = apps.find((_, i) => nameMatches(match, candidates[i], 'exact'));
    return exact ?? apps.find((_, i) => nameMatches(match, candidates[i], 'contains'));
  }

  private async windowTitles(app: NodeHandle): Promise<string[]> {
    const tree = await walk(this.backend, app, { maxDepth: 1, text: false, values: false, labels: false }).catch(() => null);
    return tree ? tree.children.filter((c) => WINDOW_ROLES.has(c.info.role)).map((c) => c.name) : [];
  }

  /**
   * Start an app and wait for it to show up in the accessibility tree (and, by default, to show a
   * window). Apps launched this way are closed by `desktop.close()` unless `detached`.
   */
  async launch(command: string | string[], options: LaunchOptions = {}): Promise<App> {
    const argv = typeof command === 'string' ? splitCommand(command) : command;
    if (!argv.length) throw new NorthbridgeError('launch() needs a command');
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.backend.launchEnvironment(), ...options.env };
    delete env.NO_AT_BRIDGE;
    let stderr = '';
    const child = spawn(argv[0], argv.slice(1), {
      env,
      cwd: options.cwd,
      detached: options.detached ?? false,
      stdio: options.detached ? 'ignore' : ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    let spawnError: Error | undefined;
    child.on('error', (err) => {
      spawnError = err;
    });
    if (options.detached) child.unref();

    const timeout = options.timeout ?? 20_000;
    const deadline = Date.now() + timeout;
    const fallbackName = options.name ?? basename(argv[0]);
    for (const interval of pollIntervals()) {
      if (interval) await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
      if (spawnError) throw new NorthbridgeError(`Couldn't start ${argv[0]}: ${spawnError.message}`);
      const exited = child.exitCode !== null || child.signalCode !== null;
      if (exited && child.exitCode !== 0) {
        throw new NorthbridgeError(
          `${argv[0]} exited (${child.exitCode ?? child.signalCode}) before showing up in the accessibility tree.${stderr ? `\n${stderr.trim()}` : ''}`,
        );
      }
      const apps = await this.backend.apps();
      let found: AppHandle | undefined;
      if (options.name !== undefined) found = await this.matchApps(apps, options.name);
      else if (child.pid) found = apps.find((a) => a.pid !== undefined && (a.pid === child.pid || isDescendantOf(a.pid, child.pid!)));
      // A launcher that handed off to an already-running instance exits cleanly; match by name.
      if (!found && exited) found = await this.matchApps(apps, fallbackName);
      if (found && (options.waitForWindow === false || (await this.hasWindow(found.node)))) {
        const app = this.toApp(found, found.pid === child.pid ? child : undefined);
        if (!options.detached) this.launched.add(app);
        return app;
      }
      if (Date.now() >= deadline) break;
    }
    if (!options.detached) child.kill();
    throw new TimeoutError(
      `Timed out after ${timeout}ms waiting for ${argv[0]} to show up in the accessibility tree. ` +
        'If it is a Chromium/Electron app, pass --force-renderer-accessibility; if it hands off to another process, use { name }.' +
        (stderr ? `\n${stderr.trim()}` : ''),
    );
  }

  private async hasWindow(app: NodeHandle): Promise<boolean> {
    const tree = await walk(this.backend, app, { maxDepth: 1, text: false, values: false, labels: false }).catch(() => null);
    return !!tree?.children.some((c) => WINDOW_ROLES.has(c.info.role));
  }

  // ---------------------------------------------------------------------------------------------
  // Finding elements anywhere

  private scope(): Locator {
    return new Locator(this, { kind: 'desktop' }, { steps: [] });
  }
  locator(selector: string | Locator): Locator {
    return this.scope().locator(selector);
  }
  getByRole(role: RoleLike | RoleLike[], options?: ByRoleOptions): Locator {
    return this.scope().getByRole(role, options);
  }
  getByText(text: string | RegExp, options?: TextOptions): Locator {
    return this.scope().getByText(text, options);
  }
  getByLabel(text: string | RegExp, options?: TextOptions): Locator {
    return this.scope().getByLabel(text, options);
  }
  getById(id: string | RegExp): Locator {
    return this.scope().getById(id);
  }

  /** The element behind a ref from a snapshot ("e12"). */
  element(ref: string): Element {
    const key = this.refs.keyFor(ref);
    if (!key) throw new NorthbridgeError(`Unknown ref "${ref}". Take a snapshot first; refs come from snapshots.`);
    return new Element(this, this.backend.handleFromKey(key));
  }

  /** Every on-screen window, across all apps. */
  async windows(): Promise<Element[]> {
    const tree = await walk(this.backend, DESKTOP, { maxDepth: 2, text: false, values: false, labels: false });
    return windowsIn(tree).map((w) => new Element(this, w.handle));
  }

  /** The window with keyboard focus. */
  async activeWindow(): Promise<Element | null> {
    const tree = await walk(this.backend, DESKTOP, { maxDepth: 2, text: false, values: false, labels: false });
    const active = windowsIn(tree).find((w) => w.info.states.has('active'));
    return active ? new Element(this, active.handle) : null;
  }

  /** The element with keyboard focus. */
  async focused(): Promise<Element | null> {
    const window = await this.activeWindow();
    if (!window) return null;
    const tree = await walk(this.backend, window.handle, { text: false, values: false, labels: false });
    if (!tree) return null;
    const focused = [...selfAndDescendants(tree)].filter((n) => n.info.states.has('focused'));
    const deepest = focused.sort((a, b) => b.depth - a.depth)[0];
    return deepest ? new Element(this, deepest.handle) : null;
  }

  /** @internal Bring an element's window to the front before mouse or keyboard input. */
  async activateWindowOf(element: Element): Promise<void> {
    if (!this.backend.activateWindow) return;
    const window = await element.window().catch(() => null);
    if (!window) return;
    // Leave an active window alone: moving focus would close its open menus and popovers.
    const states = await window.states().catch((): State[] => []);
    if (states.includes('active')) return;
    await this.backend.activateWindow(window.handle).catch(() => false);
  }

  // ---------------------------------------------------------------------------------------------
  // Seeing

  /**
   * What's on screen, as text: every app and window, with the active window (or, with `all`,
   * every window) expanded in full. Refs in the output work with `element()` and selectors.
   */
  async snapshot(options: DesktopSnapshotOptions = {}): Promise<string> {
    const overview = await walk(this.backend, DESKTOP, { maxDepth: 2, text: false, values: false, labels: false });
    if (!overview) return '';
    const windows = windowsIn(overview);
    const expand = options.all ? windows : windows.filter((w) => w.info.states.has('active'));
    const targets = expand.length ? expand : windows;
    await Promise.all(
      targets.map(async (w) => {
        const full = await walk(this.backend, w.handle, { includeHidden: options.includeHidden });
        if (!full || !w.parent) return;
        full.parent = w.parent;
        w.parent.children[w.parent.children.indexOf(w)] = full;
      }),
    );
    let order = 0;
    for (const n of selfAndDescendants(overview)) n.order = order++;
    const pids = new Map<string, number | undefined>();
    await Promise.all(overview.children.map(async (a) => pids.set(a.handle.key, await this.backend.pidOf(a.handle))));
    return renderSnapshot(overview, this.refs, {
      ...options,
      annotate: (n) => {
        const pid = pids.get(n.handle.key);
        return pid ? [`pid=${pid}`] : [];
      },
    });
  }

  /** Capture the screen (or `clip`) as PNG. */
  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    if (!this.backend.screenshot) {
      throw new NotSupportedError("Screenshots aren't available on this display (northbridge captures X11 screens today)");
    }
    const png = encodePng(await this.backend.screenshot(options.clip));
    if (options.path) await writeFile(options.path, png);
    return png;
  }

  /** Close apps this desktop launched (unless detached) and disconnect. */
  async close(): Promise<void> {
    await Promise.all([...this.launched].map((app) => app.close().catch(() => {})));
    this.launched.clear();
    await this.backend.close();
  }
}

function windowsIn(tree: TreeNode | null): TreeNode[] {
  if (!tree) return [];
  return tree.children.flatMap((app) => app.children.filter((w) => WINDOW_ROLES.has(w.info.role)));
}

function nameMatches(match: string | RegExp, candidates: string[], mode: 'exact' | 'contains'): boolean {
  return candidates.some((c) => {
    if (!c) return false;
    if (match instanceof RegExp) return match.test(c);
    const a = normalizeText(c).toLowerCase();
    const b = normalizeText(match).toLowerCase();
    return mode === 'exact' ? a === b : a.includes(b);
  });
}

function describeMatch(match: AppMatch): string {
  if (typeof match === 'string') return JSON.stringify(match);
  if (match instanceof RegExp) return String(match);
  return JSON.stringify(match);
}
