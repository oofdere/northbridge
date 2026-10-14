// Renders a fetched tree as compact, YAML-ish text in the style of Playwright's ARIA snapshots:
//
//   - window "Calculator" [active] [ref=e1]:
//     - textbox [focused] [ref=e4]: "2+2"
//     - button "=" [desc="Calculate Result"] [ref=e9]
//
// Wrapper containers are flattened and duplicated labels dropped, so what's left is what a
// person would describe when looking at the screen.

import { INTERACTIVE_ROLES, type Role, STRUCTURAL_ROLES, WINDOW_ROLES } from './model.ts';
import type { RefRegistry } from './refs.ts';
import { type TreeNode, isDesktop } from './tree.ts';
import { collapseWhitespace, normalizeText, truncate } from './util.ts';

export interface SnapshotOptions {
  /** Only list things you can interact with (plus the windows and menus around them). */
  interactive?: boolean;
  /** Longest text value to print before truncating. Default 300. */
  maxTextLength?: number;
  /** Most children to print under one node before summarizing the rest. Default 200. */
  maxChildren?: number;
  /** Print `[ref=…]` markers. Default true. */
  refs?: boolean;
  /** Extra bracketed annotations per node, e.g. `pid=123` for applications. */
  annotate?: (node: TreeNode) => string[];
}

const CHECKABLE: ReadonlySet<Role> = new Set<Role>(['checkbox', 'radio', 'menuitemcheckbox', 'menuitemradio', 'switch']);
const TEXT_ROLES: ReadonlySet<Role> = new Set<Role>(['text', 'paragraph', 'caption', 'term', 'definition']);
const CONTEXT_ROLES: ReadonlySet<Role> = new Set<Role>([
  'application', 'window', 'dialog', 'alert', 'menu', 'menubar', 'tablist', 'toolbar', 'list', 'listbox',
  'tree', 'treegrid', 'table', 'row', 'tabpanel', 'statusbar', 'document',
]);

const quote = (s: string) => JSON.stringify(s);

/** The role to print: unnamed wrappers are flattened anyway, named ones read better as "group". */
function displayRole(n: TreeNode): string {
  if (n.info.role === 'generic' || n.info.role === 'unknown') return 'group';
  return n.info.role;
}

export function isInteractive(n: TreeNode): boolean {
  const { role, states } = n.info;
  // Items in lists and tables only count when you can select or focus them.
  if (role === 'listitem' || role === 'cell' || role === 'row') return states.has('selectable') || states.has('focusable');
  if (INTERACTIVE_ROLES.has(role)) return true;
  return states.has('focusable') && !STRUCTURAL_ROLES.has(role) && !WINDOW_ROLES.has(role);
}

function displayStates(n: TreeNode): string[] {
  const { role, states } = n.info;
  const out: string[] = [];
  if (states.has('mixed') && (CHECKABLE.has(role) || states.has('checkable'))) out.push('mixed');
  else if (states.has('checked')) out.push('checked');
  if (states.has('pressed')) out.push('pressed');
  if (states.has('selected') && (states.has('selectable') || role === 'tab')) out.push('selected');
  if (states.has('expandable') || states.has('expanded')) out.push(states.has('expanded') ? 'expanded' : 'collapsed');
  if (!states.has('enabled') && (isInteractive(n) || states.has('focusable'))) out.push('disabled');
  if (states.has('focused')) out.push('focused');
  if (states.has('readonly') && (role === 'textbox' || role === 'combobox' || role === 'spinbutton')) out.push('readonly');
  if (states.has('protected')) out.push('protected');
  if (states.has('required')) out.push('required');
  if (states.has('invalid')) out.push('invalid');
  if (states.has('busy')) out.push('busy');
  if (WINDOW_ROLES.has(role)) {
    if (states.has('active')) out.push('active');
    if (states.has('modal')) out.push('modal');
    if (states.has('minimized')) out.push('minimized');
  }
  if (states.has('haspopup') && (role === 'button' || role === 'combobox')) out.push('haspopup');
  return out;
}

function formatNumber(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e4) / 1e4);
}

function displayValue(n: TreeNode, maxText: number): string | undefined {
  if (n.value) return n.value.text ? quote(n.value.text) : formatNumber(n.value.current);
  if (n.text) {
    const text = n.text.replace(/\uFFFC/g, '').trim();
    if (!text || normalizeText(text) === normalizeText(n.name)) return undefined;
    return quote(truncate(text, maxText));
  }
  return undefined;
}

type Resolved = Required<Omit<SnapshotOptions, 'annotate'>> & Pick<SnapshotOptions, 'annotate'>;

function line(n: TreeNode, refs: RefRegistry | null, opts: Resolved, extraStates: string[] = []): string {
  let s = `- ${displayRole(n)}`;
  if (n.name) s += ` ${quote(truncate(collapseWhitespace(n.name), 150))}`;
  for (const st of new Set([...displayStates(n), ...extraStates])) s += ` [${st}]`;
  const value = displayValue(n, opts.maxTextLength);
  const desc = collapseWhitespace(n.info.description);
  if (desc && normalizeText(desc) !== normalizeText(n.name) && quote(desc) !== value && desc !== value) {
    s += ` [desc=${quote(truncate(desc, 100))}]`;
  }
  if (n.info.id) s += ` [id=${quote(n.info.id)}]`;
  for (const note of opts.annotate?.(n) ?? []) s += ` [${note}]`;
  if (refs && opts.refs && !isDesktop(n)) s += ` [ref=${refs.refFor(n.handle.key)}]`;
  if (value !== undefined) s += `: ${value}`;
  return s;
}

/** A node worth printing on its own line? Unnamed wrappers and decorative leaves are not. */
function isMeaningful(n: TreeNode, opts: Resolved): boolean {
  const { role, states } = n.info;
  if (isDesktop(n)) return false;
  if (opts.interactive) {
    return isInteractive(n) || (CONTEXT_ROLES.has(role) && !!n.name) || role === 'window' || role === 'dialog' || role === 'application' || role === 'menu';
  }
  if (STRUCTURAL_ROLES.has(role)) return !!n.name || states.has('focused');
  if (role === 'separator' || role === 'scrollbar') return false;
  if (role === 'image' && !n.name) return false;
  if (TEXT_ROLES.has(role) && !n.name && !n.text) return false;
  return true;
}

/** Labels that just repeat their parent's name add nothing. */
function isRedundantLabel(child: TreeNode, parentName: string): boolean {
  if (!parentName || child.info.role !== 'text') return false;
  const text = normalizeText(child.name || child.text || '');
  return !!text && text === normalizeText(parentName) && child.children.length === 0;
}

/**
 * Wrappers with a single child of the same name (GTK4 menu buttons, for instance) collapse into
 * the innermost interactive node, which is the one that actually does something.
 */
function collapseSameNamed(n: TreeNode, opts: Resolved): { node: TreeNode; extra: string[] } {
  let node = n;
  const extra: string[] = [];
  for (;;) {
    const visible = meaningfulChildren(node, opts);
    if (visible.length !== 1) break;
    const only = visible[0];
    if (!node.name || normalizeText(only.name) !== normalizeText(node.name) || !isInteractive(only)) break;
    if (node.info.states.has('haspopup')) extra.push('haspopup');
    node = only;
  }
  return { node, extra };
}

const labelText = (n: TreeNode) => normalizeText(n.name || n.text || '').replace(/:$/, '');

/** A label right next to the control it names ("Volume" beside slider "Volume") says nothing new. */
function labelsNeighbour(list: TreeNode[], i: number): boolean {
  const n = list[i];
  if (n.info.role !== 'text' || n.children.length) return false;
  const text = labelText(n);
  if (!text) return false;
  return [list[i - 1], list[i + 1]].some((m) => m && m.info.role !== 'text' && isInteractive(m) && labelText(m) === text);
}

/** Children to print, with structural wrappers flattened away. */
function meaningfulChildren(n: TreeNode, opts: Resolved): TreeNode[] {
  const out: TreeNode[] = [];
  const visit = (parent: TreeNode) => {
    for (const child of parent.children) {
      if (isRedundantLabel(child, n.name)) continue;
      if (isMeaningful(child, opts)) out.push(child);
      else visit(child);
    }
  };
  visit(n);
  return out.filter((_, i) => !labelsNeighbour(out, i));
}

function omittedCount(n: TreeNode, opts: Resolved): number {
  let total = n.omitted;
  const visit = (parent: TreeNode) => {
    for (const child of parent.children) {
      if (!isMeaningful(child, opts)) {
        total += child.omitted;
        visit(child);
      }
    }
  };
  visit(n);
  return total;
}

function render(n: TreeNode, depth: number, refs: RefRegistry | null, opts: Resolved, out: string[]): void {
  const { node, extra } = collapseSameNamed(n, opts);
  const children = meaningfulChildren(node, opts);
  const omitted = omittedCount(node, opts);
  const indent = '  '.repeat(depth);
  const head = line(node, refs, opts, extra);
  const hasBody = children.length > 0 || omitted > 0;
  // Content that exists but wasn't fetched (e.g. windows other than the active one).
  const elided = !hasBody && node.unexpanded && !head.includes(': ') ? ': …' : '';
  out.push(indent + head + (hasBody ? ':' : elided));
  const shown = children.slice(0, opts.maxChildren);
  for (const child of shown) render(child, depth + 1, refs, opts, out);
  const hidden = children.length - shown.length + omitted;
  if (hidden > 0) out.push(`${indent}  - … ${hidden} more`);
}

export function renderSnapshot(root: TreeNode, refs: RefRegistry | null, options: SnapshotOptions = {}): string {
  const opts: Resolved = {
    interactive: options.interactive ?? false,
    maxTextLength: options.maxTextLength ?? 300,
    maxChildren: options.maxChildren ?? 200,
    refs: options.refs ?? true,
    annotate: options.annotate,
  };
  const out: string[] = [];
  if (isMeaningful(root, opts) || !isDesktop(root)) {
    render(root, 0, refs, opts, out);
  } else {
    for (const child of meaningfulChildren(root, opts)) render(child, 0, refs, opts, out);
  }
  return out.join('\n');
}

/** One line describing a single node, as used in error messages. */
export function describeNode(n: TreeNode, refs: RefRegistry | null): string {
  return line(n, refs, { interactive: false, maxTextLength: 80, maxChildren: 0, refs: true }).replace(/^- /, '');
}
