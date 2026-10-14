import type { NodeHandle } from '../../src/backend.ts';
import type { NodeInfo, Role, State } from '../../src/model.ts';
import type { TreeNode } from '../../src/tree.ts';

export interface Spec {
  role: Role;
  name?: string;
  states?: State[];
  text?: string;
  id?: string;
  description?: string;
  nativeRole?: string;
  children?: Spec[];
}

let counter = 0;

/** Build a TreeNode tree from a compact spec. Every node is showing and enabled unless stated. */
export function tree(spec: Spec, parent: TreeNode | null = null): TreeNode {
  const handle: NodeHandle = { key: `node${++counter}` };
  const states = new Set<State>(spec.states ?? ['showing', 'enabled']);
  const info: NodeInfo = {
    role: spec.role,
    nativeRole: spec.nativeRole ?? spec.role,
    name: spec.name ?? '',
    description: spec.description ?? '',
    states,
    childCount: spec.children?.length ?? 0,
    id: spec.id ?? '',
    capabilities: new Set(),
  };
  const node: TreeNode = {
    handle,
    info,
    name: info.name,
    parent,
    children: [],
    depth: parent ? parent.depth + 1 : 0,
    order: 0,
    omitted: 0,
    text: spec.text,
  };
  node.children = (spec.children ?? []).map((c) => tree(c, node));
  if (!parent) {
    let order = 0;
    const visit = (n: TreeNode) => {
      n.order = order++;
      n.children.forEach(visit);
    };
    visit(node);
  }
  return node;
}

export const S = (...states: State[]): State[] => ['showing', 'enabled', ...states];
