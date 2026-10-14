// Fetches a subtree of the accessibility tree into plain objects, a level at a time with all
// requests in flight at once. Everything downstream (selectors, snapshots) works on the result
// synchronously.

import type { Backend, NodeHandle } from './backend.ts';
import { StaleElementError } from './errors.ts';
import { INTERACTIVE_ROLES, type NodeInfo, type NumericValue, type Role, STRUCTURAL_ROLES } from './model.ts';

export interface TreeNode {
  handle: NodeHandle;
  info: NodeInfo;
  /** Accessible name; for unnamed controls, taken from the label that labels them. */
  name: string;
  parent: TreeNode | null;
  children: TreeNode[];
  depth: number;
  /** Pre-order position, i.e. document order. */
  order: number;
  /** How many children were left out because of size limits. */
  omitted: number;
  /** Children exist but weren't fetched (depth limit). */
  unexpanded?: boolean;
  /** Text of the labels that label this node (from labelledBy relations), when fetched. */
  labels?: string[];
  /** Text contents, when fetched. */
  text?: string | null;
  /** Numeric value, when fetched. */
  value?: NumericValue | null;
}

export interface WalkOptions {
  /** Include nodes that aren't currently showing on screen. Default false. */
  includeHidden?: boolean;
  /** Depth below the root to descend. Default unlimited. */
  maxDepth?: number;
  /** Stop expanding after this many nodes. Default 20000. */
  maxNodes?: number;
  /** Fetch at most this many children per node. Default 2000. */
  maxChildren?: number;
  /** Fetch text contents of textboxes and of unnamed text-bearing nodes. Default true. */
  text?: boolean;
  /** Fetch numeric values of sliders, spinbuttons and progress bars. Default true. */
  values?: boolean;
  /**
   * Resolve labelledBy relations: `true` (default) names unnamed controls after their labels,
   * `'all'` also records the labels of controls that have names of their own.
   */
  labels?: boolean | 'all';
  maxTextLength?: number;
}

/** The handle used for the desktop itself: its children are the running applications. */
export const DESKTOP: NodeHandle = Object.freeze({ key: 'desktop' });

const DESKTOP_INFO: NodeInfo = {
  role: 'generic',
  nativeRole: 'desktop',
  name: 'desktop',
  description: '',
  states: new Set(['showing', 'enabled']),
  childCount: 0,
  id: '',
  capabilities: new Set(),
};

const TEXT_CONTENT_ROLES: ReadonlySet<Role> = new Set<Role>(['textbox', 'terminal', 'combobox']);
const TEXT_IF_UNNAMED_ROLES: ReadonlySet<Role> = new Set<Role>([
  'text', 'paragraph', 'heading', 'cell', 'listitem', 'link', 'caption', 'columnheader', 'rowheader',
  'treeitem', 'document', 'status', 'statusbar', 'alert', 'tooltip', 'term', 'definition', 'note', 'log',
]);
const VALUE_ROLES: ReadonlySet<Role> = new Set<Role>(['slider', 'spinbutton', 'progressbar', 'meter', 'scrollbar']);
// Roles whose name may come from a separate label (labelledBy), e.g. GTK 4 menu items.
const LABELLED_ROLES: ReadonlySet<Role> = new Set<Role>([
  ...INTERACTIVE_ROLES, 'image', 'progressbar', 'meter', 'document', 'terminal', 'listbox', 'list', 'tree',
  'table', 'treegrid', 'tablist', 'menu', 'menubar', 'toolbar', 'dialog', 'window', 'alert', 'group',
  'region', 'heading', 'tabpanel',
]);

function makeNode(handle: NodeHandle, info: NodeInfo, parent: TreeNode | null): TreeNode {
  // An application's children are its top-level windows, whatever role the toolkit gives them
  // (Qt reports a plain top-level QWidget as a "filler").
  if (parent?.info.role === 'application' && STRUCTURAL_ROLES.has(info.role)) info = { ...info, role: 'window' };
  return {
    handle,
    info,
    name: info.name,
    parent,
    children: [],
    depth: parent ? parent.depth + 1 : 0,
    order: 0,
    omitted: 0,
  };
}

export function isDesktop(node: TreeNode): boolean {
  return node.handle === DESKTOP;
}

/**
 * Fetch the subtree under `root` (or the whole desktop, for `DESKTOP`).
 * Returns null if the root itself no longer exists.
 */
export async function walk(backend: Backend, root: NodeHandle, options: WalkOptions = {}): Promise<TreeNode | null> {
  const includeHidden = options.includeHidden ?? false;
  const maxDepth = options.maxDepth ?? Infinity;
  const maxNodes = options.maxNodes ?? 20000;
  const maxChildren = options.maxChildren ?? 2000;

  let rootNode: TreeNode;
  let frontier: TreeNode[];
  let count = 1;
  if (root === DESKTOP) {
    rootNode = makeNode(DESKTOP, DESKTOP_INFO, null);
    const apps = await backend.apps();
    const infos = await Promise.all(apps.map((a) => backend.info(a.node).catch(() => null)));
    apps.forEach((a, i) => {
      const info = infos[i];
      if (info) rootNode.children.push(makeNode(a.node, info, rootNode));
    });
    count += rootNode.children.length;
    if (maxDepth > 1) frontier = rootNode.children;
    else {
      frontier = [];
      for (const app of rootNode.children) app.unexpanded = app.info.childCount > 0;
    }
  } else {
    try {
      rootNode = makeNode(root, await backend.info(root), null);
    } catch (err) {
      if (err instanceof StaleElementError) return null;
      throw err;
    }
    frontier = maxDepth > 0 ? [rootNode] : [];
    if (maxDepth === 0 && rootNode.info.childCount > 0) rootNode.unexpanded = true;
  }

  while (frontier.length && count < maxNodes) {
    const childLists = await Promise.all(
      frontier.map((n) => (n.info.childCount === 0 ? Promise.resolve([]) : backend.children(n.handle).catch(() => []))),
    );
    const next: TreeNode[] = [];
    await Promise.all(
      frontier.map(async (parent, i) => {
        let handles = childLists[i];
        if (handles.length > maxChildren) {
          parent.omitted = handles.length - maxChildren;
          handles = handles.slice(0, maxChildren);
        }
        const infos = await Promise.all(handles.map((h) => backend.info(h).catch(() => null)));
        handles.forEach((h, j) => {
          const info = infos[j];
          if (!info) return;
          if (!includeHidden && !info.states.has('showing')) return;
          parent.children.push(makeNode(h, info, parent));
        });
      }),
    );
    for (const parent of frontier) {
      const kept: TreeNode[] = [];
      for (const child of parent.children) {
        if (count >= maxNodes) {
          parent.omitted++;
          continue;
        }
        count++;
        kept.push(child);
        if (child.depth - rootNode.depth < maxDepth) next.push(child);
        else if (child.info.childCount > 0) child.unexpanded = true;
      }
      parent.children = kept;
    }
    frontier = next;
  }

  number(rootNode);
  await enrich(backend, rootNode, options);
  return rootNode;
}

function number(root: TreeNode): void {
  let order = 0;
  const visit = (n: TreeNode) => {
    n.order = order++;
    for (const c of n.children) visit(c);
  };
  visit(root);
}

export function* descendants(node: TreeNode): Generator<TreeNode> {
  for (const child of node.children) {
    yield child;
    yield* descendants(child);
  }
}

export function* selfAndDescendants(node: TreeNode): Generator<TreeNode> {
  yield node;
  yield* descendants(node);
}

/** Fill in text, values and label-derived names, all in parallel. */
async function enrich(backend: Backend, root: TreeNode, options: WalkOptions): Promise<void> {
  const wantText = options.text ?? true;
  const wantValues = options.values ?? true;
  const wantLabels = options.labels ?? true;
  const maxText = options.maxTextLength ?? 4000;
  const byKey = new Map<string, TreeNode>();
  for (const n of selfAndDescendants(root)) byKey.set(n.handle.key, n);

  const jobs: Promise<void>[] = [];
  for (const n of byKey.values()) {
    if (n.handle === DESKTOP) continue;
    const { role, capabilities, name } = n.info;
    if (wantText && capabilities.has('text') && (TEXT_CONTENT_ROLES.has(role) || (!name && TEXT_IF_UNNAMED_ROLES.has(role)))) {
      jobs.push(
        backend.text(n.handle, maxText).then(
          (t) => void (n.text = t),
          () => void (n.text = null),
        ),
      );
    }
    if (wantValues && capabilities.has('value') && VALUE_ROLES.has(role)) {
      jobs.push(
        backend.value(n.handle).then(
          (v) => void (n.value = v),
          () => void (n.value = null),
        ),
      );
    }
    if (wantLabels && (!name || wantLabels === 'all') && LABELLED_ROLES.has(role)) {
      jobs.push(
        (async () => {
          const relations = await backend.relations(n.handle).catch(() => []);
          const labels = relations.find((r) => r.type === 'labelledBy')?.targets ?? [];
          // A label's words are its name, or failing that its text (GTK 4.14 menu labels have no name).
          const labelText = async (h: NodeHandle): Promise<string> => {
            const known = byKey.get(h.key);
            const name = known ? known.info.name : await backend.info(h).then((i) => i.name, () => '');
            return name || ((await backend.text(h, 200).catch(() => null)) ?? '');
          };
          const names = await Promise.all(labels.map(labelText));
          n.labels = names.map((l) => l.trim().replace(/:$/, '')).filter(Boolean);
          if (!name && n.labels.length) n.name = n.labels.join(' ');
        })(),
      );
    }
  }
  await Promise.all(jobs);
}
