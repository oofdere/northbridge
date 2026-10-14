// The query model behind locators and selector strings, evaluated against fetched trees.

import { type Role, type State, STRUCTURAL_ROLES } from './model.ts';
import { descendants, isDesktop, type TreeNode } from './tree.ts';
import { normalizeText } from './util.ts';

export type TextMatcher =
  | { kind: 'exact'; value: string; caseSensitive?: boolean }
  | { kind: 'contains'; value: string; caseSensitive?: boolean }
  | { kind: 'regex'; value: RegExp };

/** State filters: any normalized state, plus a few negative conveniences. */
export type StateFilter = State | 'disabled' | 'visible' | 'hidden';

export interface MatchStep {
  type: 'match';
  roles?: Role[];
  name?: TextMatcher;
  /** Matches the accessible name, text contents or value text. */
  text?: TextMatcher;
  description?: TextMatcher;
  id?: TextMatcher;
  nativeRole?: TextMatcher;
  states?: Partial<Record<StateFilter, boolean>>;
  /** Also match nodes that aren't showing on screen. */
  includeHidden?: boolean;
  /** `child`: direct children only (unnamed wrappers don't count as a level). Default `descendant`. */
  combinator?: 'descendant' | 'child';
}

export interface FilterStep {
  type: 'filter';
  has?: Query;
  hasNot?: Query;
  hasText?: TextMatcher;
  hasNotText?: TextMatcher;
  visible?: boolean;
}

export type Step =
  | MatchStep
  | FilterStep
  | { type: 'nth'; index: number }
  | { type: 'ref'; ref: string }
  | { type: 'union'; queries: Query[] }
  | { type: 'intersect'; queries: Query[] };

export interface Query {
  steps: Step[];
}

export function textMatches(m: TextMatcher, input: string): boolean {
  if (m.kind === 'regex') {
    m.value.lastIndex = 0;
    return m.value.test(input);
  }
  let s = normalizeText(input);
  let v = normalizeText(m.value);
  if (!m.caseSensitive) {
    s = s.toLowerCase();
    v = v.toLowerCase();
  }
  return m.kind === 'exact' ? s === v : s.includes(v);
}

export function formatTextMatcher(m: TextMatcher): string {
  if (m.kind === 'regex') return String(m.value);
  const q = JSON.stringify(m.value);
  if (m.kind === 'contains') return `*${q}`;
  return m.caseSensitive ? `${q}s` : q;
}

/** Everything about a node that text matching looks at. */
export function nodeTexts(n: TreeNode): string[] {
  const out = [n.name];
  if (n.text) out.push(n.text);
  if (n.value?.text) out.push(n.value.text);
  return out.filter(Boolean);
}

/** Visible means showing, and so are all its ancestors (apps and the desktop don't count). */
export function isNodeVisible(n: TreeNode): boolean {
  for (let cur: TreeNode | null = n; cur; cur = cur.parent) {
    if (isDesktop(cur) || cur.info.role === 'application') continue;
    if (!cur.info.states.has('showing')) return false;
  }
  return true;
}

function stateMatches(n: TreeNode, state: StateFilter, want: boolean): boolean {
  const states = n.info.states;
  let has: boolean;
  switch (state) {
    case 'disabled':
      has = !states.has('enabled');
      break;
    case 'visible':
      has = isNodeVisible(n);
      break;
    case 'hidden':
      has = !isNodeVisible(n);
      break;
    case 'checked':
      has = states.has('checked') || states.has('pressed');
      break;
    default:
      has = states.has(state);
  }
  return has === want;
}

export function matchesStep(n: TreeNode, step: MatchStep): boolean {
  if (isDesktop(n)) return false;
  if (step.roles && !step.roles.includes(n.info.role)) return false;
  if (step.name && !textMatches(step.name, n.name)) return false;
  if (step.text && !nodeTexts(n).some((t) => textMatches(step.text!, t))) return false;
  if (step.description && !textMatches(step.description, n.info.description)) return false;
  if (step.id && !textMatches(step.id, n.info.id)) return false;
  if (step.nativeRole && !textMatches(step.nativeRole, n.info.nativeRole)) return false;
  if (step.states) {
    for (const [state, want] of Object.entries(step.states)) {
      if (want !== undefined && !stateMatches(n, state as StateFilter, want)) return false;
    }
  }
  if (!step.includeHidden && !step.states?.hidden && !isNodeVisible(n)) return false;
  return true;
}

/** Children as they appear in snapshots: unnamed wrappers are see-through. */
function visibleChildren(n: TreeNode): TreeNode[] {
  const out: TreeNode[] = [];
  for (const c of n.children) {
    if (STRUCTURAL_ROLES.has(c.info.role) && !c.name) out.push(...visibleChildren(c));
    else out.push(c);
  }
  return out;
}

function inDocumentOrder(nodes: Iterable<TreeNode>): TreeNode[] {
  const unique = new Map<TreeNode, true>();
  for (const n of nodes) unique.set(n, true);
  return [...unique.keys()].sort((a, b) => a.order - b.order);
}

function containsNode(ancestor: TreeNode, n: TreeNode): boolean {
  for (let cur = n.parent; cur; cur = cur.parent) if (cur === ancestor) return true;
  return false;
}

export interface EvalContext {
  /** Resolve a ref like "e12" to a node in the tree (or undefined). */
  resolveRef(ref: string): TreeNode | undefined;
}

export function evaluate(query: Query, context: TreeNode[], env: EvalContext): TreeNode[] {
  let current = context;
  for (const step of query.steps) {
    switch (step.type) {
      case 'match': {
        const found: TreeNode[] = [];
        for (const scope of current) {
          const pool = step.combinator === 'child' ? visibleChildren(scope) : descendants(scope);
          for (const n of pool) if (matchesStep(n, step)) found.push(n);
        }
        let result = inDocumentOrder(found);
        // Text searches report the innermost element holding the text (a label, not its button).
        if (step.text && !step.roles) result = result.filter((n) => !result.some((m) => m !== n && containsNode(n, m)));
        current = result;
        break;
      }
      case 'nth': {
        const i = step.index < 0 ? current.length + step.index : step.index;
        current = current[i] ? [current[i]] : [];
        break;
      }
      case 'filter':
        current = current.filter((n) => {
          if (step.has && evaluate(step.has, [n], env).length === 0) return false;
          if (step.hasNot && evaluate(step.hasNot, [n], env).length > 0) return false;
          if (step.hasText || step.hasNotText) {
            const texts = [...nodeTexts(n)];
            for (const d of descendants(n)) texts.push(...nodeTexts(d));
            const joined = texts.join(' ');
            if (step.hasText && !textMatches(step.hasText, joined) && !texts.some((t) => textMatches(step.hasText!, t))) return false;
            if (step.hasNotText && (textMatches(step.hasNotText, joined) || texts.some((t) => textMatches(step.hasNotText!, t)))) return false;
          }
          if (step.visible !== undefined && isNodeVisible(n) !== step.visible) return false;
          return true;
        });
        break;
      case 'ref': {
        const node = env.resolveRef(step.ref);
        current = node && current.some((scope) => scope === node || containsNode(scope, node)) ? [node] : [];
        break;
      }
      case 'union':
        current = inDocumentOrder(step.queries.flatMap((q) => evaluate(q, current, env)));
        break;
      case 'intersect': {
        const [first, ...rest] = step.queries.map((q) => new Set(evaluate(q, current, env)));
        current = inDocumentOrder([...(first ?? [])].filter((n) => rest.every((s) => s.has(n))));
        break;
      }
    }
  }
  return current;
}

/** Whether any step needs nodes that aren't on screen. */
export function needsHidden(query: Query): boolean {
  return query.steps.some((s) => {
    if (s.type === 'match') return !!s.includeHidden || s.states?.hidden === true || s.states?.visible === false;
    if (s.type === 'filter') return (s.has && needsHidden(s.has)) || (s.hasNot && needsHidden(s.hasNot)) || s.visible === false;
    if (s.type === 'union' || s.type === 'intersect') return s.queries.some(needsHidden);
    return false;
  });
}

/** Render a query back into selector syntax, for messages. */
export function formatQuery(query: Query): string {
  const parts: string[] = [];
  for (const step of query.steps) {
    switch (step.type) {
      case 'match': {
        let s = step.roles ? (step.roles.length === 1 ? step.roles[0] : `:is(${step.roles.join(',')})`) : '';
        if (step.name) s += `${s ? ' ' : ''}${formatTextMatcher(step.name)}`;
        if (step.text) s += `:text(${formatTextMatcher(step.text)})`;
        if (step.id) s = `#${step.id.kind === 'regex' ? step.id.value : step.id.value}${s ? ` ${s}` : ''}`;
        if (step.description) s += `[description=${formatTextMatcher(step.description)}]`;
        if (step.nativeRole) s += `[native=${formatTextMatcher(step.nativeRole)}]`;
        for (const [k, v] of Object.entries(step.states ?? {})) s += v ? `[${k}]` : `[${k}=false]`;
        if (step.includeHidden) s += ':any-visibility';
        if (!s) s = '*';
        parts.push(step.combinator === 'child' && parts.length ? `> ${s}` : s);
        break;
      }
      case 'nth':
        parts.push(step.index === 0 ? ':first' : step.index === -1 ? ':last' : `:nth(${step.index})`);
        break;
      case 'filter': {
        let s = '';
        if (step.has) s += `:has(${formatQuery(step.has)})`;
        if (step.hasNot) s += `:not(:has(${formatQuery(step.hasNot)}))`;
        if (step.hasText) s += `:has-text(${formatTextMatcher(step.hasText)})`;
        if (step.hasNotText) s += `:not(:has-text(${formatTextMatcher(step.hasNotText)}))`;
        if (step.visible !== undefined) s += step.visible ? ':visible' : ':hidden';
        parts.push(s);
        break;
      }
      case 'ref':
        parts.push(`@${step.ref}`);
        break;
      case 'union':
        parts.push(`:is(${step.queries.map(formatQuery).join(', ')})`);
        break;
      case 'intersect':
        parts.push(step.queries.map(formatQuery).join(''));
        break;
    }
  }
  return parts.join(' ').replace(/ (:(first|last|nth|has|not|visible|hidden))/g, '$1');
}
