// The platform-independent model every backend maps into: ARIA-flavoured roles,
// a flat set of states, and the core facts about a node.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Normalized roles. Close to ARIA so the vocabulary is familiar from the web. */
export const ROLES = [
  'alert', 'application', 'article', 'audio', 'blockquote', 'button', 'calendar', 'canvas',
  'caption', 'cell', 'checkbox', 'columnheader', 'combobox', 'definition', 'dialog', 'document',
  'form', 'generic', 'group', 'heading', 'image', 'link', 'list', 'listbox', 'listitem', 'log',
  'math', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter', 'note',
  'paragraph', 'progressbar', 'radio', 'region', 'row', 'rowheader', 'scrollbar', 'separator',
  'slider', 'spinbutton', 'status', 'statusbar', 'switch', 'tab', 'table', 'tablist', 'tabpanel',
  'term', 'terminal', 'text', 'textbox', 'timer', 'titlebar', 'toolbar', 'tooltip', 'tree',
  'treegrid', 'treeitem', 'unknown', 'video', 'window',
] as const;

export type Role = (typeof ROLES)[number];

const ROLE_SET: ReadonlySet<string> = new Set(ROLES);

/** Other names people (and other toolkits) use for the same roles. */
const ROLE_ALIASES: Record<string, Role> = {
  pushbutton: 'button',
  togglebutton: 'button',
  menubutton: 'button',
  splitbutton: 'button',
  checkbutton: 'checkbox',
  check: 'checkbox',
  radiobutton: 'radio',
  toggle: 'switch',
  entry: 'textbox',
  input: 'textbox',
  edit: 'textbox',
  textfield: 'textbox',
  textarea: 'textbox',
  passwordtext: 'textbox',
  searchbox: 'textbox',
  searchfield: 'textbox',
  field: 'textbox',
  label: 'text',
  statictext: 'text',
  static: 'text',
  frame: 'window',
  sheet: 'dialog',
  alertdialog: 'dialog',
  dropdown: 'combobox',
  select: 'combobox',
  popupbutton: 'combobox',
  hyperlink: 'link',
  img: 'image',
  icon: 'image',
  picture: 'image',
  pagetab: 'tab',
  tabitem: 'tab',
  pagetablist: 'tablist',
  tabs: 'tablist',
  tabgroup: 'tablist',
  popupmenu: 'menu',
  contextmenu: 'menu',
  menuitemcheck: 'menuitemcheckbox',
  checkmenuitem: 'menuitemcheckbox',
  radiomenuitem: 'menuitemradio',
  spinner: 'spinbutton',
  stepper: 'spinbutton',
  progress: 'progressbar',
  levelbar: 'meter',
  tablecell: 'cell',
  gridcell: 'cell',
  tablerow: 'row',
  dataitem: 'row',
  outline: 'tree',
  outlinerow: 'treeitem',
  toolbarbutton: 'button',
  heading1: 'heading',
  header: 'heading',
  pane: 'generic',
  panel: 'generic',
  section: 'generic',
  container: 'generic',
  div: 'generic',
  grouping: 'group',
  datagrid: 'table',
  grid: 'table',
  scrollarea: 'generic',
  tooltips: 'tooltip',
};

/** Resolve a user-supplied role ("push button", "Button", "entry") to a normalized role. */
export function normalizeRole(input: string): Role | undefined {
  const key = input.toLowerCase().replace(/[\s_-]+/g, '');
  if (ROLE_SET.has(key)) return key as Role;
  return ROLE_ALIASES[key];
}

export const STATES = [
  'active', 'busy', 'checkable', 'checked', 'collapsed', 'default', 'defunct', 'editable',
  'enabled', 'expandable', 'expanded', 'focusable', 'focused', 'haspopup', 'horizontal',
  'invalid', 'minimized', 'mixed', 'modal', 'multiline', 'multiselectable', 'pressed',
  'protected', 'readonly', 'required', 'selectable', 'selected', 'showing', 'transient',
  'vertical', 'visited',
] as const;

export type State = (typeof STATES)[number];

/** What a node can do, independent of how the platform spells it. */
export type Capability =
  | 'action'
  | 'text'
  | 'editableText'
  | 'value'
  | 'selection'
  | 'component'
  | 'table'
  | 'image'
  | 'hyperlink'
  | 'document';

/** The core facts about a node: enough to match selectors and render snapshots. */
export interface NodeInfo {
  role: Role;
  /** The platform's own role name, e.g. "push button" (AT-SPI), "AXButton" (macOS), "Button" (UIA). */
  nativeRole: string;
  name: string;
  description: string;
  states: ReadonlySet<State>;
  childCount: number;
  /** Developer-assigned identifier (AT-SPI AccessibleId, AXIdentifier, AutomationId). */
  id: string;
  capabilities: ReadonlySet<Capability>;
}

export interface NumericValue {
  current: number;
  min: number;
  max: number;
  step: number;
  /** Platform-provided display text, when there is one (e.g. "50%"). */
  text?: string;
}

/** Roles a user typically interacts with directly. */
export const INTERACTIVE_ROLES: ReadonlySet<Role> = new Set<Role>([
  'button', 'checkbox', 'combobox', 'link', 'listitem', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'radio', 'scrollbar', 'slider', 'spinbutton', 'switch', 'tab', 'textbox',
  'treeitem', 'cell', 'columnheader', 'rowheader', 'row',
]);

/** Containers that carry no meaning on their own when unnamed; snapshots flatten them. */
export const STRUCTURAL_ROLES: ReadonlySet<Role> = new Set<Role>(['generic', 'unknown', 'group', 'region', 'form']);

/** Roles that are windows of an application. */
export const WINDOW_ROLES: ReadonlySet<Role> = new Set<Role>(['window', 'dialog', 'alert']);
