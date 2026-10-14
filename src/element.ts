// An Element is one concrete accessible object. Locators find Elements; Elements do things.

import type { ActionInfo, MouseButton, NodeHandle } from './backend.ts';
import type { Desktop } from './desktop.ts';
import { NotSupportedError, StaleElementError, TimeoutError } from './errors.ts';
import { Locator, type ByRoleOptions, type RoleLike, type TextOptions } from './locator.ts';
import type { NodeInfo, NumericValue, Rect, State } from './model.ts';
import { WINDOW_ROLES } from './model.ts';
import { textMatches, type TextMatcher } from './query.ts';
import { describeNode, renderSnapshot, type SnapshotOptions } from './snapshot.ts';
import { descendants, walk, type TreeNode } from './tree.ts';
import { normalizeText, pollIntervals, sleep } from './util.ts';

export interface ClickOptions {
  button?: MouseButton;
  clickCount?: number;
  /** Keys to hold during a mouse click, e.g. ['Control']. */
  modifiers?: string[];
  /**
   * How to click. `auto` (default) uses the element's accessibility action when it has one and a
   * real mouse click otherwise; `action` only uses accessibility actions; `mouse` always clicks.
   */
  method?: 'auto' | 'action' | 'mouse';
  /** Point to click, relative to the element's top-left corner. Implies a mouse click. */
  position?: { x: number; y: number };
}

export interface TypeOptions {
  /** Milliseconds between keystrokes. */
  delay?: number;
}

export type SelectOption = string | RegExp | { index: number };

// Accessibility actions that mean "do the primary thing", in order of preference. Names are the
// toolkit's programmatic names, lower-cased: GTK says click/press/activate, Qt Press/Toggle,
// Firefox press/jump/check/switch/open, Chromium click/jump.
const PRIMARY_ACTIONS = ['click', 'press', 'jump', 'toggle', 'check', 'uncheck', 'switch', 'open', 'select', 'invoke'];
const EXPAND_ACTIONS = ['expand', 'expand or contract', 'expand or collapse', 'open', 'press', 'toggle'];
const COLLAPSE_ACTIONS = ['collapse', 'expand or contract', 'expand or collapse', 'close', 'press', 'toggle'];
const TEXT_INPUT_ROLES = new Set(['textbox', 'terminal', 'document', 'spinbutton']);
const SELECTABLE_ITEM_ROLES = new Set(['listitem', 'treeitem', 'cell', 'row', 'tab']);

/**
 * Synthesized input reaches the app over X while our accessibility requests travel over D-Bus,
 * so the app may handle them in either order. A moment's pause keeps "click, then read" honest.
 */
const settle = () => sleep(40);
const OPTION_ROLES = new Set(['menuitem', 'menuitemradio', 'menuitemcheckbox', 'listitem', 'treeitem', 'tab', 'cell', 'row', 'radio']);

export class Element {
  readonly desktop: Desktop;
  readonly handle: NodeHandle;

  constructor(desktop: Desktop, handle: NodeHandle) {
    this.desktop = desktop;
    this.handle = handle;
  }

  private get backend() {
    return this.desktop.backend;
  }

  /** A short reference like "e12" that stays valid while the element exists. */
  get ref(): string {
    return this.desktop.refs.refFor(this.handle.key);
  }

  toString(): string {
    return `Element(${this.ref})`;
  }

  // ---------------------------------------------------------------------------------------------
  // Finding things inside this element

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

  // ---------------------------------------------------------------------------------------------
  // Reading

  info(): Promise<NodeInfo> {
    return this.backend.info(this.handle);
  }
  async exists(): Promise<boolean> {
    try {
      const info = await this.info();
      return !info.states.has('defunct');
    } catch (err) {
      if (err instanceof StaleElementError) return false;
      throw err;
    }
  }
  async role(): Promise<string> {
    return (await this.info()).role;
  }
  async name(): Promise<string> {
    const node = await walk(this.backend, this.handle, { maxDepth: 0, text: false, values: false });
    if (!node) throw new StaleElementError(`${this} no longer exists`);
    return node.name;
  }
  async description(): Promise<string> {
    return (await this.info()).description;
  }
  async id(): Promise<string> {
    return (await this.info()).id;
  }
  async states(): Promise<State[]> {
    return [...(await this.info()).states].sort();
  }
  /** Text contents (for text fields, labels, documents), falling back to the accessible name. */
  async text(): Promise<string> {
    const info = await this.info();
    if (info.capabilities.has('text')) {
      const text = await this.backend.text(this.handle);
      if (text !== null && (text.replace(/\uFFFC/g, '').trim() || !info.name)) return text.replace(/\uFFFC/g, '');
    }
    return info.name;
  }
  /** Current value of a slider, spin button, progress bar or other ranged control. */
  value(): Promise<NumericValue | null> {
    return this.backend.value(this.handle);
  }
  bounds(): Promise<Rect | null> {
    return this.backend.bounds(this.handle);
  }
  async actions(): Promise<string[]> {
    return (await this.backend.actions(this.handle)).map((a) => a.name);
  }
  attributes(): Promise<Record<string, string>> {
    return this.backend.attributes(this.handle);
  }
  async parent(): Promise<Element | null> {
    const parent = await this.backend.parent(this.handle);
    return parent ? new Element(this.desktop, parent) : null;
  }
  async children(): Promise<Element[]> {
    return (await this.backend.children(this.handle)).map((h) => new Element(this.desktop, h));
  }
  /** The window (or dialog) containing this element. */
  async window(): Promise<Element | null> {
    let cur: NodeHandle | null = this.handle;
    let below: NodeHandle | null = null;
    for (let i = 0; cur && i < 200; i++) {
      const info = await this.backend.info(cur);
      if (WINDOW_ROLES.has(info.role)) return new Element(this.desktop, cur);
      // Whatever sits directly under the application is a top-level window.
      if (info.role === 'application') return below ? new Element(this.desktop, below) : null;
      below = cur;
      cur = await this.backend.parent(cur);
    }
    return null;
  }
  /** The application this element belongs to. */
  app() {
    return this.desktop.appFor(this.handle);
  }

  async isVisible(): Promise<boolean> {
    try {
      return (await this.info()).states.has('showing');
    } catch (err) {
      if (err instanceof StaleElementError) return false;
      throw err;
    }
  }
  async isEnabled(): Promise<boolean> {
    return (await this.info()).states.has('enabled');
  }
  async isChecked(): Promise<boolean> {
    const { states } = await this.info();
    return states.has('checked') || states.has('pressed');
  }
  async isFocused(): Promise<boolean> {
    return (await this.info()).states.has('focused');
  }
  async isEditable(): Promise<boolean> {
    const { states } = await this.info();
    return states.has('editable') && !states.has('readonly');
  }
  async isSelected(): Promise<boolean> {
    return (await this.info()).states.has('selected');
  }
  async isExpanded(): Promise<boolean> {
    return (await this.info()).states.has('expanded');
  }

  /** One line in snapshot format, e.g. `button "Save" [ref=e12]`. */
  async describe(): Promise<string> {
    const node = await walk(this.backend, this.handle, { maxDepth: 0 });
    if (!node) throw new StaleElementError(`${this} no longer exists`);
    return describeNode(node, this.desktop.refs);
  }

  /** The accessibility tree under this element, as text. */
  async snapshot(options: SnapshotOptions & { includeHidden?: boolean; depth?: number } = {}): Promise<string> {
    const tree = await walk(this.backend, this.handle, { includeHidden: options.includeHidden, maxDepth: options.depth });
    if (!tree) throw new StaleElementError(`${this} no longer exists`);
    return renderSnapshot(tree, this.desktop.refs, options);
  }

  /** PNG of just this element. */
  async screenshot(options: { path?: string } = {}): Promise<Buffer> {
    const box = await this.bounds();
    if (!box) throw new NotSupportedError(`${await this.describe()} has no on-screen bounds to capture`);
    return this.desktop.screenshot({ ...options, clip: box });
  }

  // ---------------------------------------------------------------------------------------------
  // Doing

  private async findAction(names: string[], handle = this.handle): Promise<number> {
    const actions: ActionInfo[] = await this.backend.actions(handle);
    const lower = actions.map((a) => a.name.toLowerCase());
    for (const name of names) {
      const i = lower.indexOf(name);
      if (i >= 0) return i;
    }
    return -1;
  }

  /** Run a named accessibility action ("activate", "expand or contract", "menu.popup", …). */
  async invoke(action: string): Promise<void> {
    const actions = await this.backend.actions(this.handle);
    const wanted = action.toLowerCase();
    let i = actions.findIndex((a) => a.name.toLowerCase() === wanted);
    if (i < 0) i = actions.findIndex((a) => a.name.toLowerCase().includes(wanted));
    if (i < 0) {
      const available = actions.map((a) => a.name).filter(Boolean);
      throw new NotSupportedError(
        `${await this.describe()} has no "${action}" action. ${available.length ? `Available: ${available.join(', ')}` : 'It has no actions.'}`,
      );
    }
    await this.backend.doAction(this.handle, i);
  }

  /**
   * Click it. By default (`method: 'auto'`) this uses whichever is more reliable for the app's
   * toolkit: the element's own accessibility action (works on covered or off-screen windows, and
   * without any input synthesis), or a real pointer click (for toolkits whose accessibility
   * actions can freeze behind a modal dialog). Either way it falls back to the other.
   */
  async click(options: ClickOptions = {}): Promise<void> {
    const { button = 'left', clickCount = 1, method = 'auto' } = options;
    const plain = button === 'left' && !options.modifiers?.length && !options.position;
    if (method === 'mouse' || (!plain && method === 'auto')) {
      await this.mouseClick(options);
      return;
    }
    if (method === 'auto' && clickCount === 1 && (await this.pointerIsSafer()) && (await this.tryMouseClick(options))) return;
    const done = clickCount === 2 ? await this.semanticDoubleClick() : clickCount === 1 ? await this.semanticClick() : false;
    if (done) return;
    if (method === 'action') {
      throw new NotSupportedError(`${await this.describe()} has no accessibility action for this click; use method: 'mouse'`);
    }
    await this.mouseClick(options);
  }

  async dblclick(options: Omit<ClickOptions, 'clickCount'> = {}): Promise<void> {
    await this.click({ ...options, clickCount: 2 });
  }

  private async pointerIsSafer(): Promise<boolean> {
    if (!this.desktop.hasInput()) return false;
    const info = await this.info();
    // Clicking into text means focusing it, and list rows are selected precisely: both stay semantic.
    if (TEXT_INPUT_ROLES.has(info.role)) return false;
    if (info.states.has('selectable') && SELECTABLE_ITEM_ROLES.has(info.role)) return false;
    return this.backend.prefersPointerClicks(this.handle).catch(() => false);
  }

  private async tryMouseClick(options: ClickOptions): Promise<boolean> {
    try {
      await this.mouseClick(options);
      return true;
    } catch (err) {
      if (err instanceof NotSupportedError) return false;
      throw err;
    }
  }

  private async semanticClick(): Promise<boolean> {
    const info = await this.info();
    // Clicking into a text field means focusing it, never "activate" (which submits).
    if (TEXT_INPUT_ROLES.has(info.role) && info.capabilities.has('text')) return this.backend.focus(this.handle);
    const own = await this.findAction(PRIMARY_ACTIONS);
    if (own >= 0) return this.backend.doAction(this.handle, own);
    if (info.states.has('selectable') && (await this.selectInParent())) return true;
    const activate = await this.findAction(['activate', 'default.activate']);
    if (activate >= 0) return this.backend.doAction(this.handle, activate);
    // Wrappers around a single actionable thing (GTK4 menu buttons): click the inner one.
    let handle = this.handle;
    for (let depth = 0; depth < 4; depth++) {
      const children = await this.backend.children(handle);
      if (children.length !== 1) break;
      handle = children[0];
      const i = await this.findAction(PRIMARY_ACTIONS, handle);
      if (i >= 0) return this.backend.doAction(handle, i);
    }
    // Text or images inside something clickable (a label in a button): click the container.
    if (info.role === 'text' || info.role === 'image' || info.role === 'generic') {
      let parent = await this.backend.parent(this.handle);
      for (let depth = 0; parent && depth < 3; depth++) {
        const pinfo = await this.backend.info(parent);
        if (WINDOW_ROLES.has(pinfo.role) || pinfo.role === 'application') break;
        const i = await this.findAction(PRIMARY_ACTIONS, parent);
        if (i >= 0) return this.backend.doAction(parent, i);
        parent = await this.backend.parent(parent);
      }
    }
    return false;
  }

  private async semanticDoubleClick(): Promise<boolean> {
    const i = await this.findAction(['activate', 'default.activate', 'open']);
    if (i >= 0) return this.backend.doAction(this.handle, i);
    return false;
  }

  private async selectInParent(): Promise<boolean> {
    const parent = await this.backend.parent(this.handle);
    if (!parent) return false;
    const pinfo = await this.backend.info(parent);
    if (!pinfo.capabilities.has('selection') && !pinfo.capabilities.has('table')) return false;
    const index = await this.backend.indexInParent(this.handle);
    if (index < 0) return false;
    if (await this.backend.selectChild(parent, index).catch(() => false)) return true;
    // GTK 3 tree views only take selectChild when they have a single column.
    if (pinfo.capabilities.has('table')) return this.backend.selectTableRow(parent, index).catch(() => false);
    return false;
  }

  /** Where a mouse click lands: the centre, or `position` relative to the top-left corner. */
  async clickPoint(position?: { x: number; y: number }): Promise<{ x: number; y: number }> {
    await this.backend.scrollIntoView(this.handle).catch(() => false);
    const box = await this.bounds();
    if (!box) throw new NotSupportedError(`${await this.describe()} has no on-screen position to click`);
    const point = position
      ? { x: box.x + position.x, y: box.y + position.y }
      : { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    const screen = this.backend.screenBounds;
    if (screen && (point.x < screen.x || point.y < screen.y || point.x >= screen.x + screen.width || point.y >= screen.y + screen.height)) {
      throw new NotSupportedError(`${await this.describe()} is off screen at (${point.x}, ${point.y})`);
    }
    return point;
  }

  private async mouseClick(options: ClickOptions): Promise<void> {
    const mouse = this.desktop.mouse;
    const keyboard = this.desktop.keyboard;
    await this.desktop.activateWindowOf(this);
    const point = await this.clickPoint(options.position);
    const modifiers = options.modifiers ?? [];
    for (const m of modifiers) await keyboard.down(m);
    try {
      await mouse.click(point.x, point.y, { button: options.button, clickCount: options.clickCount });
    } finally {
      for (const m of [...modifiers].reverse()) await keyboard.up(m);
    }
    await settle();
  }

  /** Move the mouse over the element. */
  async hover(): Promise<void> {
    await this.desktop.activateWindowOf(this);
    const point = await this.clickPoint();
    await this.desktop.mouse.move(point.x, point.y);
  }

  /** Give the element keyboard focus. */
  async focus(): Promise<void> {
    if ((await this.info()).states.has('focused')) return;
    if (await this.backend.focus(this.handle).catch(() => false)) return;
    await this.desktop.activateWindowOf(this);
    if (await this.backend.focus(this.handle).catch(() => false)) return;
    const info = await this.info();
    if (!info.states.has('focusable')) throw new NotSupportedError(`${await this.describe()} can't take keyboard focus`);
  }

  /** Replace the text in an editable element. */
  async fill(text: string): Promise<void> {
    const info = await this.info();
    if (info.role === 'spinbutton' && info.capabilities.has('value') && text.trim() !== '' && Number.isFinite(Number(text))) {
      await this.setValue(Number(text));
      return;
    }
    if (!info.states.has('editable') && !info.capabilities.has('editableText')) {
      throw new NotSupportedError(`${await this.describe()} is not editable`);
    }
    if (info.states.has('readonly')) throw new NotSupportedError(`${await this.describe()} is read-only`);
    if (info.capabilities.has('editableText')) {
      const ok = await this.backend.setText(this.handle, text).catch(() => false);
      if (ok) {
        const now = await this.backend.text(this.handle);
        if (now === null || normalizeText(now) === normalizeText(text)) return;
      }
    }
    // No (working) editable-text interface: do it the way a person would.
    await this.desktop.activateWindowOf(this);
    await this.focus();
    const keyboard = this.desktop.keyboard;
    await keyboard.press('ControlOrMeta+a');
    if (text) await keyboard.type(text);
    else await keyboard.press('Delete');
  }

  async clear(): Promise<void> {
    await this.fill('');
  }

  /** Focus the element and type text key by key, as a person would. */
  async type(text: string, options: TypeOptions = {}): Promise<void> {
    if (this.desktop.hasInput()) await this.desktop.activateWindowOf(this);
    await this.focus();
    // Toolkits select a field's text when it gains focus; typing should add to it, not replace it.
    const info = await this.info();
    if (info.capabilities.has('text')) {
      const length = ((await this.backend.text(this.handle)) ?? '').length;
      await this.backend.setCaret(this.handle, length).catch(() => false);
    }
    if (this.desktop.hasInput()) {
      await this.desktop.keyboard.type(text, options);
      await settle();
      return;
    }
    // No input synthesis on this display server: insert at the caret instead.
    if (!info.capabilities.has('editableText')) throw this.desktop.noInputError('type into this element');
    const caret = await this.backend.caretOffset(this.handle).catch(() => -1);
    const position = caret >= 0 ? caret : ((await this.backend.text(this.handle)) ?? '').length;
    await this.backend.insertText(this.handle, position, text);
  }

  /** Focus the element and press a key or combination ("Enter", "Control+a"). */
  async press(key: string): Promise<void> {
    if (this.desktop.hasInput()) await this.desktop.activateWindowOf(this);
    await this.focus();
    if (this.desktop.hasInput()) {
      await this.desktop.keyboard.press(key);
      await settle();
      return;
    }
    // Enter in a text field means "activate" — that one we can do without a keyboard.
    if (/^(enter|return)$/i.test(key)) {
      const i = await this.findAction(['activate']);
      if (i >= 0) {
        await this.backend.doAction(this.handle, i);
        return;
      }
    }
    throw this.desktop.noInputError(`press ${key}`);
  }

  async check(): Promise<void> {
    await this.setChecked(true);
  }
  async uncheck(): Promise<void> {
    await this.setChecked(false);
  }
  async setChecked(checked: boolean): Promise<void> {
    if ((await this.isChecked()) === checked) return;
    const info = await this.info();
    if (!checked && info.role === 'radio') throw new NotSupportedError('A radio button is unchecked by checking another one');
    await this.click();
    await this.waitUntil(async () => (await this.isChecked()) === checked, `${checked ? 'checked' : 'unchecked'}`);
  }

  /** Set a slider, spin button or other ranged control. */
  async setValue(value: number): Promise<void> {
    const info = await this.info();
    if (!info.capabilities.has('value')) throw new NotSupportedError(`${await this.describe()} has no value to set`);
    await this.backend.setValue(this.handle, value);
    await this.waitUntil(async () => {
      const v = await this.value();
      return !v || Math.abs(v.current - value) <= Math.max(v.step, 1e-9) || v.current === v.min || v.current === v.max;
    }, `value ${value}`);
  }

  /** Pick an option in a combo box, list, tab list or menu, by name or `{ index }`. */
  async selectOption(option: SelectOption): Promise<void> {
    const tree = await walk(this.backend, this.handle, { includeHidden: true, maxDepth: 6 });
    if (!tree) throw new StaleElementError(`${this} no longer exists`);
    const options = [...descendants(tree)].filter((n) => OPTION_ROLES.has(n.info.role) && (n.name || n.text));
    const target = pickOption(options, option);
    if (!target) {
      const names = options.map((o) => JSON.stringify(o.name || o.text)).slice(0, 30);
      throw new NotSupportedError(
        `No option ${typeof option === 'object' && 'index' in option ? `#${option.index}` : JSON.stringify(String(option))} in ${describeNode(tree, this.desktop.refs)}. ${names.length ? `Options: ${names.join(', ')}` : 'It has no options.'}`,
      );
    }
    // A combo box has really changed only once it shows the option; other containers just select.
    const label = normalizeText(target.name || target.text || '');
    const isCombo = tree.info.role === 'combobox';
    const committed = async () => {
      if (!isCombo) return true;
      const shown = normalizeText(await this.text().catch(() => ''));
      return shown === label || normalizeText(await this.name().catch(() => '')) === label;
    };
    const settled = async () => {
      for (let i = 0; i < 6; i++) {
        if (await committed()) return true;
        await sleep(50);
      }
      return false;
    };
    // Prefer the Selection interface: first on the control itself (a GTK combo box selects its
    // active row that way), then on the option's container (lists, tab lists).
    const index = await this.backend.indexInParent(target.handle).catch(() => -1);
    if (index >= 0) {
      for (const holder of new Set([tree, target.parent ?? tree])) {
        if (!holder.info.capabilities.has('selection')) continue;
        if ((await this.backend.selectChild(holder.handle, index).catch(() => false)) && (await settled())) return;
      }
    }
    // Otherwise open it and pick the option, like a person: Qt only commits a combo box choice
    // from a real click (or Enter) in its popup.
    const optionEl = new Element(this.desktop, target.handle);
    if (!(await optionEl.isVisible())) {
      await this.click();
      await this.waitUntil(() => optionEl.isVisible(), 'its options to appear');
    }
    await optionEl.click(this.desktop.hasInput() ? { method: 'mouse' } : {});
    if (await settled()) return;
    if (this.desktop.hasInput()) {
      await this.desktop.keyboard.press('Enter');
      if (await settled()) return;
    }
    throw new NotSupportedError(`Picked ${JSON.stringify(label)} in ${describeNode(tree, this.desktop.refs)}, but it didn't take`);
  }

  async expand(): Promise<void> {
    if (await this.isExpanded()) return;
    const i = await this.findAction(EXPAND_ACTIONS);
    if (i >= 0) await this.backend.doAction(this.handle, i);
    else await this.click();
    await this.waitUntil(() => this.isExpanded(), 'expanded');
  }

  async collapse(): Promise<void> {
    if (!(await this.isExpanded())) return;
    const i = await this.findAction(COLLAPSE_ACTIONS);
    if (i >= 0) await this.backend.doAction(this.handle, i);
    else await this.click();
    await this.waitUntil(async () => !(await this.isExpanded()), 'collapsed');
  }

  async scrollIntoView(): Promise<void> {
    await this.backend.scrollIntoView(this.handle);
  }

  private async waitUntil(predicate: () => Promise<boolean>, what: string, timeout = this.desktop.timeout): Promise<void> {
    const deadline = Date.now() + timeout;
    for (const interval of pollIntervals()) {
      if (interval) await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
      if (await predicate()) return;
      if (Date.now() >= deadline) break;
    }
    throw new TimeoutError(`Timed out after ${timeout}ms waiting for ${await this.describe().catch(() => String(this))} to become ${what}`);
  }
}

function pickOption(options: TreeNode[], option: SelectOption): TreeNode | undefined {
  if (typeof option === 'object' && !(option instanceof RegExp)) return options[option.index];
  const label = (n: TreeNode) => n.name || n.text || '';
  if (option instanceof RegExp) return options.find((n) => textMatches({ kind: 'regex', value: option }, label(n)));
  const exact: TextMatcher = { kind: 'exact', value: option };
  const contains: TextMatcher = { kind: 'contains', value: option };
  return options.find((n) => textMatches(exact, label(n))) ?? options.find((n) => textMatches(contains, label(n)));
}
