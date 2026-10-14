// Locators describe how to find elements. They re-query the live tree every time they are used,
// wait for the element to show up and be ready, and refuse to guess when several things match.

import type { NodeHandle } from './backend.ts';
import type { Desktop } from './desktop.ts';
import { Element, type ClickOptions, type SelectOption, type TypeOptions } from './element.ts';
import { NorthbridgeError, StrictModeError, TimeoutError } from './errors.ts';
import { normalizeRole, type NumericValue, type Rect, type Role, type State } from './model.ts';
import {
  evaluate,
  formatQuery,
  isNodeVisible,
  type MatchStep,
  needsHidden,
  needsLabels,
  type Query,
  type Step,
  type TextMatcher,
} from './query.ts';
import { parseSelector, SelectorError } from './selector.ts';
import { describeNode, type SnapshotOptions } from './snapshot.ts';
import { DESKTOP, descendants, selfAndDescendants, type TreeNode, walk } from './tree.ts';
import { editDistance, normalizeText, pollIntervals, sleep } from './util.ts';

export type RoleLike = Role | (string & {});
export type LocatorRoot = { kind: 'desktop' } | { kind: 'node'; handle: NodeHandle };

export interface ByRoleOptions {
  /** Accessible name. A string matches the whole name, ignoring case and extra whitespace. */
  name?: string | RegExp;
  /** Match the name case-sensitively. */
  exact?: boolean;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  pressed?: boolean;
  selected?: boolean;
  focused?: boolean;
  description?: string | RegExp;
  /** Also match elements that aren't showing (closed menus, other tabs). */
  includeHidden?: boolean;
}

export interface TextOptions {
  /** Match the whole string, case-sensitively, instead of a case-insensitive substring. */
  exact?: boolean;
}

export interface FilterOptions {
  has?: Locator;
  hasNot?: Locator;
  hasText?: string | RegExp;
  hasNotText?: string | RegExp;
  visible?: boolean;
}

export interface TimeoutOptions {
  /** Milliseconds to wait. Defaults to the desktop's timeout (5s unless changed). */
  timeout?: number;
}

export type WaitState = 'attached' | 'detached' | 'visible' | 'hidden';

type Condition = 'attached' | 'visible' | 'enabled';

const LABELLABLE_ROLES: Role[] = [
  'textbox', 'combobox', 'spinbutton', 'slider', 'checkbox', 'radio', 'switch', 'listbox', 'list',
  'tree', 'treegrid', 'table', 'button', 'image', 'progressbar', 'meter', 'document', 'terminal',
  'menuitemcheckbox', 'menuitemradio', 'tablist', 'group',
];

function nameMatcher(name: string | RegExp, exact?: boolean): TextMatcher {
  if (name instanceof RegExp) return { kind: 'regex', value: name };
  return { kind: 'exact', value: name, caseSensitive: !!exact };
}

function textMatcher(text: string | RegExp, exact?: boolean): TextMatcher {
  if (text instanceof RegExp) return { kind: 'regex', value: text };
  return exact ? { kind: 'exact', value: text, caseSensitive: true } : { kind: 'contains', value: text };
}

function rootKey(root: LocatorRoot): string {
  return root.kind === 'desktop' ? 'desktop' : root.handle.key;
}

export interface Resolution {
  tree: TreeNode | null;
  matches: TreeNode[];
}

export class Locator {
  readonly desktop: Desktop;
  readonly root: LocatorRoot;
  readonly query: Query;

  constructor(desktop: Desktop, root: LocatorRoot, query: Query) {
    this.desktop = desktop;
    this.root = root;
    this.query = query;
  }

  private with(...steps: Step[]): Locator {
    return new Locator(this.desktop, this.root, { steps: [...this.query.steps, ...steps] });
  }

  toString(): string {
    return this.query.steps.length ? formatQuery(this.query) : '(scope)';
  }

  // ---------------------------------------------------------------------------------------------
  // Building

  /** Narrow with a selector string (see selector.ts) or another locator, searched inside this one. */
  locator(selector: string | Locator): Locator {
    if (selector instanceof Locator) return this.with(...selector.query.steps);
    return this.with(...parseSelector(selector).steps);
  }

  /** Find by role and accessible name, e.g. `getByRole('button', { name: 'Save' })`. */
  getByRole(role: RoleLike | RoleLike[], options: ByRoleOptions = {}): Locator {
    const roles = (Array.isArray(role) ? role : [role]).map((r) => {
      const normalized = normalizeRole(r);
      if (!normalized) throw new SelectorError(`Unknown role "${r}"`);
      return normalized;
    });
    const step: MatchStep = { type: 'match', roles };
    if (options.name !== undefined) step.name = nameMatcher(options.name, options.exact);
    if (options.description !== undefined) step.description = nameMatcher(options.description, options.exact);
    const states: MatchStep['states'] = {};
    for (const key of ['checked', 'disabled', 'expanded', 'pressed', 'selected', 'focused'] as const) {
      if (options[key] !== undefined) states[key] = options[key];
    }
    if (Object.keys(states).length) step.states = states;
    if (options.includeHidden) step.includeHidden = true;
    return this.with(step);
  }

  /** Find by visible text: a case-insensitive substring of the name or contents, unless `exact`. */
  getByText(text: string | RegExp, options: TextOptions = {}): Locator {
    return this.with({ type: 'match', text: textMatcher(text, options.exact) });
  }

  /** Find a control by the label that names it (a case-insensitive substring unless `exact`). */
  getByLabel(text: string | RegExp, options: TextOptions = {}): Locator {
    return this.with({ type: 'match', roles: LABELLABLE_ROLES, label: textMatcher(text, options.exact) });
  }

  /** Find by developer-assigned accessible id (AccessibleId / AXIdentifier / AutomationId). */
  getById(id: string | RegExp): Locator {
    return this.with({ type: 'match', id: id instanceof RegExp ? { kind: 'regex', value: id } : { kind: 'exact', value: id, caseSensitive: true } });
  }

  filter(options: FilterOptions): Locator {
    return this.with({
      type: 'filter',
      has: options.has?.query,
      hasNot: options.hasNot?.query,
      hasText: options.hasText !== undefined ? textMatcher(options.hasText) : undefined,
      hasNotText: options.hasNotText !== undefined ? textMatcher(options.hasNotText) : undefined,
      visible: options.visible,
    });
  }

  nth(index: number): Locator {
    return this.with({ type: 'nth', index });
  }
  first(): Locator {
    return this.nth(0);
  }
  last(): Locator {
    return this.nth(-1);
  }

  /** Elements matching this locator or the other one. */
  or(other: Locator): Locator {
    this.assertSameRoot(other, 'or');
    return new Locator(this.desktop, this.root, { steps: [{ type: 'union', queries: [this.query, other.query] }] });
  }

  /** Elements matching both this locator and the other one. */
  and(other: Locator): Locator {
    this.assertSameRoot(other, 'and');
    return new Locator(this.desktop, this.root, { steps: [{ type: 'intersect', queries: [this.query, other.query] }] });
  }

  private assertSameRoot(other: Locator, op: string): void {
    if (rootKey(other.root) !== rootKey(this.root)) {
      throw new NorthbridgeError(`locator.${op}() needs both locators to come from the same app or element`);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Resolving

  /** Query the live tree once, without waiting. */
  async resolve(): Promise<Resolution> {
    const { backend, refs } = this.desktop;
    const includeHidden = needsHidden(this.query);
    let steps = this.query.steps;
    let rootHandle: NodeHandle = this.root.kind === 'desktop' ? DESKTOP : this.root.handle;
    let selfOnly = false;
    const first = steps[0];
    if (first?.type === 'ref') {
      // Refs name an element directly; only walk what's under it.
      const key = refs.keyFor(first.ref);
      if (!key) throw new NorthbridgeError(`Unknown ref "${first.ref}". Refs come from snapshots taken in this session.`);
      rootHandle = backend.handleFromKey(key);
      steps = steps.slice(1);
      selfOnly = true;
    }
    const needsChildren = steps.some((s) => s.type !== 'nth');
    const tree = await walk(backend, rootHandle, {
      includeHidden,
      maxDepth: selfOnly && !needsChildren ? 0 : undefined,
      labels: needsLabels(this.query) ? 'all' : true,
    });
    if (!tree) return { tree: null, matches: [] };
    let byKey: Map<string, TreeNode> | undefined;
    const env = {
      resolveRef: (ref: string) => {
        const key = refs.keyFor(ref);
        if (!key) return undefined;
        byKey ??= new Map([...selfAndDescendants(tree)].map((n) => [n.handle.key, n]));
        return byKey.get(key);
      },
    };
    const matches = evaluate({ steps }, [tree], env);
    return { tree, matches: selfOnly && !steps.length ? [tree] : matches };
  }

  /** How many elements match right now. */
  async count(): Promise<number> {
    return (await this.resolve()).matches.length;
  }

  /** All matching elements right now (no waiting). */
  async all(): Promise<Element[]> {
    return (await this.resolve()).matches.map((n) => new Element(this.desktop, n.handle));
  }

  /** Wait for exactly one visible match and return it. */
  async element(options: TimeoutOptions = {}): Promise<Element> {
    return (await this.waitForOne('visible', options.timeout)).element;
  }

  /** Wait until the locator is attached (in the tree), visible, detached or hidden. */
  async waitFor(options: TimeoutOptions & { state?: WaitState } = {}): Promise<void> {
    const state = options.state ?? 'visible';
    if (state === 'attached' || state === 'visible') {
      await this.waitForOne(state, options.timeout);
      return;
    }
    const timeout = options.timeout ?? this.desktop.timeout;
    const deadline = Date.now() + timeout;
    let last: Resolution = { tree: null, matches: [] };
    for (const interval of pollIntervals()) {
      if (interval) await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
      last = await this.resolve();
      const remaining = state === 'detached' ? last.matches : last.matches.filter(isNodeVisible);
      if (remaining.length === 0) return;
      if (Date.now() >= deadline) break;
    }
    const lines = last.matches.slice(0, 5).map((n) => `  - ${describeNode(n, this.desktop.refs)}`);
    throw new TimeoutError(`Timed out after ${timeout}ms waiting for ${this} to be ${state}. Still there:\n${lines.join('\n')}`);
  }

  private async waitForOne(condition: Condition, timeout = this.desktop.timeout): Promise<{ element: Element; node: TreeNode }> {
    const deadline = Date.now() + timeout;
    let last: Resolution = { tree: null, matches: [] };
    let problem = 'no element matched';
    for (const interval of pollIntervals()) {
      if (interval) await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
      last = await this.resolve();
      const { matches } = last;
      if (matches.length > 1) throw this.strictError(matches);
      if (matches.length === 1) {
        const node = matches[0];
        problem = this.unmet(node, condition);
        if (!problem) return { element: new Element(this.desktop, node.handle), node };
      } else if (!last.tree) {
        problem = this.root.kind === 'node' ? 'the element it searches in is gone' : 'no element matched';
      } else {
        problem = 'no element matched';
      }
      if (Date.now() >= deadline) break;
    }
    throw new TimeoutError(this.timeoutMessage(timeout, condition, problem, last));
  }

  private unmet(node: TreeNode, condition: Condition): string {
    if (condition === 'attached') return '';
    if (!isNodeVisible(node)) return `it matched ${describeNode(node, this.desktop.refs)} but that isn't visible`;
    if (condition === 'enabled' && !node.info.states.has('enabled')) return `it matched ${describeNode(node, this.desktop.refs)} but that is disabled`;
    return '';
  }

  private strictError(matches: TreeNode[]): StrictModeError {
    const lines = matches.slice(0, 10).map((n) => describeNode(n, this.desktop.refs));
    const more = matches.length > 10 ? `\n  …and ${matches.length - 10} more` : '';
    return new StrictModeError(
      `${this} matched ${matches.length} elements; narrow it down (by name, .first(), .nth(i)) or use a ref:\n` +
        lines.map((l) => `  - ${l}`).join('\n') +
        more,
      lines,
    );
  }

  private timeoutMessage(timeout: number, condition: Condition, problem: string, last: Resolution): string {
    const where = !last.tree ? '' : last.tree.handle === DESKTOP ? ' on the desktop' : ` in ${describeNode(last.tree, this.desktop.refs)}`;
    let message = `Timed out after ${timeout}ms waiting for ${this}${where}${condition === 'enabled' ? ' to be visible and enabled' : condition === 'visible' ? ' to be visible' : ''}: ${problem}.`;
    if (last.tree && last.matches.length === 0) {
      const similar = this.suggestions(last.tree);
      if (similar.length) message += `\nSimilar elements:\n${similar.map((n) => `  - ${describeNode(n, this.desktop.refs)}`).join('\n')}`;
    }
    return message;
  }

  /** Elements a human would think we meant: a close name, or failing that, the same role. */
  private suggestions(tree: TreeNode): TreeNode[] {
    const step = [...this.query.steps].reverse().find((s): s is MatchStep => s.type === 'match');
    if (!step) return [];
    const pool = [...descendants(tree)].filter((n) => isNodeVisible(n));
    const sameRole = (n: TreeNode) => !step.roles || step.roles.includes(n.info.role);
    const wanted = step.name ?? step.text ?? step.label;
    if (wanted && wanted.kind !== 'regex') {
      const target = normalizeText(wanted.value).toLowerCase();
      const scored: [TreeNode, number][] = [];
      for (const n of pool) {
        const name = normalizeText(n.name || n.text || '').toLowerCase();
        if (!name) continue;
        let score: number;
        if (name.includes(target) || (name.length > 2 && target.includes(name))) score = 1;
        else {
          const distance = editDistance(name, target);
          if (distance > Math.max(2, target.length / 3)) continue;
          score = 1 + distance;
        }
        if (!sameRole(n)) score += 3;
        scored.push([n, score]);
      }
      if (scored.length) {
        return scored
          .sort((a, b) => a[1] - b[1] || a[0].order - b[0].order)
          .slice(0, 6)
          .map(([n]) => n);
      }
    }
    return step.roles ? pool.filter(sameRole).slice(0, 8) : [];
  }

  private async actionable(timeout?: number): Promise<Element> {
    return (await this.waitForOne('enabled', timeout)).element;
  }

  private async attached(timeout?: number): Promise<{ element: Element; node: TreeNode }> {
    return this.waitForOne('attached', timeout);
  }

  // ---------------------------------------------------------------------------------------------
  // Reading (waits for the element to exist)

  async name(options: TimeoutOptions = {}): Promise<string> {
    return (await this.attached(options.timeout)).node.name;
  }
  async role(options: TimeoutOptions = {}): Promise<Role> {
    return (await this.attached(options.timeout)).node.info.role;
  }
  async description(options: TimeoutOptions = {}): Promise<string> {
    return (await this.attached(options.timeout)).node.info.description;
  }
  async id(options: TimeoutOptions = {}): Promise<string> {
    return (await this.attached(options.timeout)).node.info.id;
  }
  async states(options: TimeoutOptions = {}): Promise<State[]> {
    return [...(await this.attached(options.timeout)).node.info.states].sort();
  }
  async text(options: TimeoutOptions = {}): Promise<string> {
    return (await this.attached(options.timeout)).element.text();
  }
  async value(options: TimeoutOptions = {}): Promise<NumericValue | null> {
    return (await this.attached(options.timeout)).element.value();
  }
  async bounds(options: TimeoutOptions = {}): Promise<Rect | null> {
    return (await this.attached(options.timeout)).element.bounds();
  }
  async actions(options: TimeoutOptions = {}): Promise<string[]> {
    return (await this.attached(options.timeout)).element.actions();
  }
  async attributes(options: TimeoutOptions = {}): Promise<Record<string, string>> {
    return (await this.attached(options.timeout)).element.attributes();
  }
  async describe(options: TimeoutOptions = {}): Promise<string> {
    return describeNode((await this.attached(options.timeout)).node, this.desktop.refs);
  }

  /** Is there a visible match right now? Doesn't wait. */
  async isVisible(): Promise<boolean> {
    const { matches } = await this.resolve();
    if (matches.length > 1) throw this.strictError(matches);
    return matches.length === 1 && isNodeVisible(matches[0]);
  }
  async isHidden(): Promise<boolean> {
    return !(await this.isVisible());
  }
  async isEnabled(options: TimeoutOptions = {}): Promise<boolean> {
    return (await this.attached(options.timeout)).node.info.states.has('enabled');
  }
  async isDisabled(options: TimeoutOptions = {}): Promise<boolean> {
    return !(await this.isEnabled(options));
  }
  async isChecked(options: TimeoutOptions = {}): Promise<boolean> {
    const { states } = (await this.attached(options.timeout)).node.info;
    return states.has('checked') || states.has('pressed');
  }
  async isFocused(options: TimeoutOptions = {}): Promise<boolean> {
    return (await this.attached(options.timeout)).node.info.states.has('focused');
  }
  async isEditable(options: TimeoutOptions = {}): Promise<boolean> {
    const { states } = (await this.attached(options.timeout)).node.info;
    return states.has('editable') && !states.has('readonly');
  }
  async isSelected(options: TimeoutOptions = {}): Promise<boolean> {
    return (await this.attached(options.timeout)).node.info.states.has('selected');
  }
  async isExpanded(options: TimeoutOptions = {}): Promise<boolean> {
    return (await this.attached(options.timeout)).node.info.states.has('expanded');
  }

  /** The matched element's subtree as snapshot text. */
  async snapshot(options: SnapshotOptions & TimeoutOptions & { includeHidden?: boolean; depth?: number } = {}): Promise<string> {
    return (await this.attached(options.timeout)).element.snapshot(options);
  }

  async screenshot(options: TimeoutOptions & { path?: string } = {}): Promise<Buffer> {
    return (await this.waitForOne('visible', options.timeout)).element.screenshot(options);
  }

  // ---------------------------------------------------------------------------------------------
  // Acting (waits for one visible, enabled match)

  async click(options: ClickOptions & TimeoutOptions = {}): Promise<void> {
    await (await this.actionable(options.timeout)).click(options);
  }
  async dblclick(options: Omit<ClickOptions, 'clickCount'> & TimeoutOptions = {}): Promise<void> {
    await (await this.actionable(options.timeout)).dblclick(options);
  }
  async hover(options: TimeoutOptions = {}): Promise<void> {
    await (await this.waitForOne('visible', options.timeout)).element.hover();
  }
  async focus(options: TimeoutOptions = {}): Promise<void> {
    await (await this.actionable(options.timeout)).focus();
  }
  async fill(text: string, options: TimeoutOptions = {}): Promise<void> {
    await (await this.actionable(options.timeout)).fill(text);
  }
  async clear(options: TimeoutOptions = {}): Promise<void> {
    await (await this.actionable(options.timeout)).clear();
  }
  async type(text: string, options: TypeOptions & TimeoutOptions = {}): Promise<void> {
    await (await this.actionable(options.timeout)).type(text, options);
  }
  async press(key: string, options: TimeoutOptions = {}): Promise<void> {
    await (await this.actionable(options.timeout)).press(key);
  }
  async check(options: TimeoutOptions = {}): Promise<void> {
    await (await this.actionable(options.timeout)).check();
  }
  async uncheck(options: TimeoutOptions = {}): Promise<void> {
    await (await this.actionable(options.timeout)).uncheck();
  }
  async setChecked(checked: boolean, options: TimeoutOptions = {}): Promise<void> {
    await (await this.actionable(options.timeout)).setChecked(checked);
  }
  async setValue(value: number, options: TimeoutOptions = {}): Promise<void> {
    await (await this.actionable(options.timeout)).setValue(value);
  }
  async selectOption(option: SelectOption, options: TimeoutOptions = {}): Promise<void> {
    await (await this.actionable(options.timeout)).selectOption(option);
  }
  async expand(options: TimeoutOptions = {}): Promise<void> {
    await (await this.actionable(options.timeout)).expand();
  }
  async collapse(options: TimeoutOptions = {}): Promise<void> {
    await (await this.actionable(options.timeout)).collapse();
  }
  async scrollIntoView(options: TimeoutOptions = {}): Promise<void> {
    await (await this.attached(options.timeout)).element.scrollIntoView();
  }
  async invoke(action: string, options: TimeoutOptions = {}): Promise<void> {
    await (await this.actionable(options.timeout)).invoke(action);
  }
}

