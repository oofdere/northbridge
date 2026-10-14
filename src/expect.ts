// Auto-retrying assertions for tests: they poll until the UI catches up or the timeout runs out.
// Works with any test runner (node:test, vitest, jest, mocha): failures throw AssertionError.

import { AssertionError } from 'node:assert';
import { Element } from './element.ts';
import { StaleElementError, StrictModeError } from './errors.ts';
import { Locator } from './locator.ts';
import type { State } from './model.ts';
import { pollIntervals, sleep } from './util.ts';
import { normalizeText } from './util.ts';

export interface ExpectOptions {
  /** Milliseconds to keep retrying. Defaults to the desktop's timeout. */
  timeout?: number;
}

type Target = Locator | Element;

interface Check {
  pass: boolean;
  actual: unknown;
}

function describeTarget(target: Target): string {
  return target instanceof Locator ? String(target) : target.toString();
}

function textEquals(actual: string, expected: string | RegExp): boolean {
  if (expected instanceof RegExp) return expected.test(actual);
  return normalizeText(actual) === normalizeText(expected);
}

function textContains(actual: string, expected: string | RegExp): boolean {
  if (expected instanceof RegExp) return expected.test(actual);
  return normalizeText(actual).includes(normalizeText(expected));
}

export class Assertions {
  private readonly target: Target;
  private readonly negate: boolean;
  private readonly options: ExpectOptions;

  constructor(target: Target, negate = false, options: ExpectOptions = {}) {
    this.target = target;
    this.negate = negate;
    this.options = options;
  }

  /** The same assertions, inverted. */
  get not(): Assertions {
    return new Assertions(this.target, !this.negate, this.options);
  }

  private get desktop() {
    return this.target.desktop;
  }

  private async poll(what: string, expected: unknown, check: () => Promise<Check>, options: ExpectOptions = {}): Promise<void> {
    const timeout = options.timeout ?? this.options.timeout ?? this.desktop.timeout;
    const deadline = Date.now() + timeout;
    let last: Check = { pass: false, actual: undefined };
    let lastError: unknown;
    for (const interval of pollIntervals()) {
      if (interval) await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
      try {
        last = await check();
        lastError = undefined;
        if (last.pass !== this.negate) return;
      } catch (err) {
        if (err instanceof StrictModeError) throw err;
        lastError = err;
      }
      if (Date.now() >= deadline) break;
    }
    const subject = describeTarget(this.target);
    const verb = this.negate ? `not ${what}` : what;
    let message = `expect(${subject}).${this.negate ? 'not.' : ''}${verb} failed after ${timeout}ms`;
    if (expected !== undefined) message += `\n  expected: ${this.negate ? 'not ' : ''}${format(expected)}`;
    if (lastError) message += `\n  error: ${(lastError as Error).message?.split('\n')[0]}`;
    else message += `\n  received: ${format(last.actual)}`;
    throw new AssertionError({ message, actual: last.actual, expected, operator: what });
  }

  /** Resolve to a single element, waiting the poll's own retries rather than the locator's. */
  private async element(): Promise<Element> {
    if (this.target instanceof Element) return this.target;
    const { matches } = await this.target.resolve();
    if (matches.length > 1) await this.target.isVisible(); // throws the strict-mode error with details
    if (!matches.length) throw new StaleElementError(`no element matches ${this.target}`);
    return new Element(this.desktop, matches[0].handle);
  }

  private async states(): Promise<Set<State>> {
    return new Set(await (await this.element()).states());
  }

  async toBeVisible(options?: ExpectOptions): Promise<void> {
    await this.poll('toBeVisible', undefined, async () => {
      const visible = this.target instanceof Locator ? await this.target.isVisible() : await this.target.isVisible();
      return { pass: visible, actual: visible ? 'visible' : 'hidden or missing' };
    }, options);
  }

  async toBeHidden(options?: ExpectOptions): Promise<void> {
    await this.poll('toBeHidden', undefined, async () => {
      const visible = this.target instanceof Locator ? await this.target.isVisible() : await this.target.isVisible();
      return { pass: !visible, actual: visible ? 'visible' : 'hidden' };
    }, options);
  }

  /** At least one element in the tree, visible or not. */
  async toBeAttached(options?: ExpectOptions): Promise<void> {
    await this.poll('toBeAttached', undefined, async () => {
      const count = this.target instanceof Locator ? await this.target.count() : (await this.target.exists()) ? 1 : 0;
      return { pass: count > 0, actual: count ? 'attached' : 'not in the tree' };
    }, options);
  }

  private async state(name: string, check: (s: Set<State>) => boolean, options?: ExpectOptions): Promise<void> {
    await this.poll(name, undefined, async () => {
      const states = await this.states();
      return { pass: check(states), actual: [...states].sort().join(', ') || '(no states)' };
    }, options);
  }

  toBeEnabled(options?: ExpectOptions): Promise<void> {
    return this.state('toBeEnabled', (s) => s.has('enabled'), options);
  }
  toBeDisabled(options?: ExpectOptions): Promise<void> {
    return this.state('toBeDisabled', (s) => !s.has('enabled'), options);
  }
  toBeChecked(options?: ExpectOptions & { checked?: boolean }): Promise<void> {
    const want = options?.checked ?? true;
    return this.state('toBeChecked', (s) => (s.has('checked') || s.has('pressed')) === want, options);
  }
  toBeFocused(options?: ExpectOptions): Promise<void> {
    return this.state('toBeFocused', (s) => s.has('focused'), options);
  }
  toBeEditable(options?: ExpectOptions): Promise<void> {
    return this.state('toBeEditable', (s) => s.has('editable') && !s.has('readonly'), options);
  }
  toBeSelected(options?: ExpectOptions): Promise<void> {
    return this.state('toBeSelected', (s) => s.has('selected'), options);
  }
  toBeExpanded(options?: ExpectOptions): Promise<void> {
    return this.state('toBeExpanded', (s) => s.has('expanded'), options);
  }
  /** Any normalized state, e.g. `toHaveState('busy')`. */
  toHaveState(state: State, options?: ExpectOptions): Promise<void> {
    return this.state(`toHaveState(${state})`, (s) => s.has(state), options);
  }

  /** Text contents (or name) equal to `expected` after whitespace normalization; RegExp tests it. */
  async toHaveText(expected: string | RegExp | (string | RegExp)[], options?: ExpectOptions): Promise<void> {
    if (Array.isArray(expected)) {
      await this.poll('toHaveText', expected, async () => {
        const elements = this.target instanceof Locator ? await this.target.all() : [this.target];
        const texts = await Promise.all(elements.map((e) => e.text()));
        const pass = texts.length === expected.length && texts.every((t, i) => textEquals(t, expected[i]));
        return { pass, actual: texts };
      }, options);
      return;
    }
    await this.poll('toHaveText', expected, async () => {
      const text = await (await this.element()).text();
      return { pass: textEquals(text, expected), actual: text };
    }, options);
  }

  async toContainText(expected: string | RegExp, options?: ExpectOptions): Promise<void> {
    await this.poll('toContainText', expected, async () => {
      const text = await (await this.element()).text();
      return { pass: textContains(text, expected), actual: text };
    }, options);
  }

  /** The accessible name. */
  async toHaveName(expected: string | RegExp, options?: ExpectOptions): Promise<void> {
    await this.poll('toHaveName', expected, async () => {
      const name = this.target instanceof Locator ? await this.target.name({ timeout: 0 }) : await this.target.name();
      return { pass: textEquals(name, expected), actual: name };
    }, options);
  }

  async toHaveDescription(expected: string | RegExp, options?: ExpectOptions): Promise<void> {
    await this.poll('toHaveDescription', expected, async () => {
      const description = await (await this.element()).description();
      return { pass: textEquals(description, expected), actual: description };
    }, options);
  }

  async toHaveRole(expected: string, options?: ExpectOptions): Promise<void> {
    await this.poll('toHaveRole', expected, async () => {
      const role = await (await this.element()).role();
      return { pass: role === expected, actual: role };
    }, options);
  }

  async toHaveId(expected: string, options?: ExpectOptions): Promise<void> {
    await this.poll('toHaveId', expected, async () => {
      const id = await (await this.element()).id();
      return { pass: id === expected, actual: id };
    }, options);
  }

  /** A number for ranged controls (sliders, spin buttons, progress bars), text for text fields. */
  async toHaveValue(expected: number | string | RegExp, options?: ExpectOptions): Promise<void> {
    await this.poll('toHaveValue', expected, async () => {
      const el = await this.element();
      if (typeof expected === 'number') {
        const value = await el.value();
        return { pass: !!value && Math.abs(value.current - expected) < 1e-9, actual: value?.current ?? null };
      }
      const text = await el.text();
      return { pass: textEquals(text, expected), actual: text };
    }, options);
  }

  async toHaveCount(expected: number, options?: ExpectOptions): Promise<void> {
    await this.poll('toHaveCount', expected, async () => {
      const count = this.target instanceof Locator ? await this.target.count() : (await this.target.exists()) ? 1 : 0;
      return { pass: count === expected, actual: count };
    }, options);
  }
}

function format(v: unknown): string {
  if (v instanceof RegExp) return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Assert on a locator or element, retrying until it passes or times out. */
export function expect(target: Target, options?: ExpectOptions): Assertions {
  return new Assertions(target, false, options);
}
