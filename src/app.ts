import type { ChildProcess } from 'node:child_process';
import type { NodeHandle } from './backend.ts';
import type { Desktop } from './desktop.ts';
import { Element } from './element.ts';
import { NorthbridgeError } from './errors.ts';
import { Locator, type ByRoleOptions, type RoleLike, type TextOptions } from './locator.ts';
import { WINDOW_ROLES } from './model.ts';
import { isAlive } from './process.ts';
import type { SnapshotOptions } from './snapshot.ts';
import { sleep } from './util.ts';

/** A running application. Find things in it with the same methods as locators. */
export class App {
  readonly desktop: Desktop;
  /** The application's root accessible object. */
  readonly element: Element;
  /** The name the app gives itself in the accessibility tree. */
  readonly name: string;
  readonly pid: number | undefined;
  /** Set when northbridge launched the app. */
  readonly process: ChildProcess | undefined;

  constructor(desktop: Desktop, handle: NodeHandle, name: string, pid: number | undefined, child?: ChildProcess) {
    this.desktop = desktop;
    this.element = new Element(desktop, handle);
    this.name = name;
    this.pid = pid;
    this.process = child;
  }

  get handle(): NodeHandle {
    return this.element.handle;
  }

  get ref(): string {
    return this.element.ref;
  }

  toString(): string {
    return `App(${JSON.stringify(this.name)}${this.pid ? `, pid ${this.pid}` : ''})`;
  }

  private scope(): Locator {
    return new Locator(this.desktop, { kind: 'node', handle: this.handle }, { steps: [] });
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

  /** The app's windows and dialogs that are on screen. */
  async windows(): Promise<Element[]> {
    return this.window().all();
  }

  /** A top-level window or dialog of this app, optionally by title. */
  window(title?: string | RegExp): Locator {
    const step = this.scope().getByRole([...WINDOW_ROLES], title === undefined ? {} : { name: title });
    // Windows are direct children of the application.
    const query = step.query.steps.map((s) => (s.type === 'match' ? { ...s, combinator: 'child' as const } : s));
    return new Locator(this.desktop, { kind: 'node', handle: this.handle }, { steps: query });
  }

  /** The app's focused window, if it has one. */
  async activeWindow(): Promise<Element | null> {
    for (const w of await this.windows()) {
      if ((await w.states()).includes('active')) return w;
    }
    return null;
  }

  /** The whole app as snapshot text. */
  snapshot(options: SnapshotOptions & { includeHidden?: boolean; depth?: number } = {}): Promise<string> {
    return this.element.snapshot(options);
  }

  get running(): boolean {
    if (this.process) return this.process.exitCode === null && this.process.signalCode === null;
    return this.pid !== undefined && isAlive(this.pid);
  }

  /** Ask the app to quit (SIGTERM), and kill it if it hasn't after `timeout` ms. */
  async close(options: { timeout?: number } = {}): Promise<void> {
    if (this.pid === undefined) throw new NorthbridgeError(`Don't know the process id of ${this}`);
    if (!this.running) return;
    const timeout = options.timeout ?? 5000;
    try {
      process.kill(this.pid, 'SIGTERM');
    } catch {
      return;
    }
    const deadline = Date.now() + timeout;
    while (this.running && Date.now() < deadline) await sleep(50);
    if (this.running) {
      try {
        process.kill(this.pid, 'SIGKILL');
      } catch {}
    }
  }
}
