import type { RelationType } from '../backend.ts';
import type { Capability, Role, State } from '../model.ts';

// AtspiRole, in enum order (atspi-constants.h), with the normalized role each maps to.
const ROLE_TABLE: [native: string, role: Role][] = [
  ['invalid', 'unknown'],
  ['accelerator label', 'text'],
  ['alert', 'alert'],
  ['animation', 'image'],
  ['arrow', 'image'],
  ['calendar', 'calendar'],
  ['canvas', 'canvas'],
  ['check box', 'checkbox'],
  ['check menu item', 'menuitemcheckbox'],
  ['color chooser', 'group'],
  ['column header', 'columnheader'],
  ['combo box', 'combobox'],
  ['date editor', 'textbox'],
  ['desktop icon', 'button'],
  ['desktop frame', 'window'],
  ['dial', 'slider'],
  ['dialog', 'dialog'],
  ['directory pane', 'group'],
  ['drawing area', 'canvas'],
  ['file chooser', 'group'],
  ['filler', 'generic'],
  ['focus traversable', 'generic'],
  ['font chooser', 'group'],
  ['frame', 'window'],
  ['glass pane', 'generic'],
  ['html container', 'generic'],
  ['icon', 'image'],
  ['image', 'image'],
  ['internal frame', 'window'],
  ['label', 'text'],
  ['layered pane', 'generic'],
  ['list', 'list'],
  ['list item', 'listitem'],
  ['menu', 'menu'],
  ['menu bar', 'menubar'],
  ['menu item', 'menuitem'],
  ['option pane', 'group'],
  ['page tab', 'tab'],
  ['page tab list', 'tablist'],
  ['panel', 'generic'],
  ['password text', 'textbox'],
  ['popup menu', 'menu'],
  ['progress bar', 'progressbar'],
  ['push button', 'button'],
  ['radio button', 'radio'],
  ['radio menu item', 'menuitemradio'],
  ['root pane', 'generic'],
  ['row header', 'rowheader'],
  ['scroll bar', 'scrollbar'],
  ['scroll pane', 'generic'],
  ['separator', 'separator'],
  ['slider', 'slider'],
  ['spin button', 'spinbutton'],
  ['split pane', 'generic'],
  ['status bar', 'statusbar'],
  ['table', 'table'],
  ['table cell', 'cell'],
  ['table column header', 'columnheader'],
  ['table row header', 'rowheader'],
  ['tearoff menu item', 'menuitem'],
  ['terminal', 'terminal'],
  ['text', 'textbox'],
  ['toggle button', 'button'],
  ['tool bar', 'toolbar'],
  ['tool tip', 'tooltip'],
  ['tree', 'tree'],
  ['tree table', 'treegrid'],
  ['unknown', 'unknown'],
  ['viewport', 'generic'],
  ['window', 'window'],
  ['extended', 'generic'],
  ['header', 'group'],
  ['footer', 'group'],
  ['paragraph', 'paragraph'],
  ['ruler', 'generic'],
  ['application', 'application'],
  ['autocomplete', 'combobox'],
  ['editbar', 'textbox'],
  ['embedded', 'generic'],
  ['entry', 'textbox'],
  ['chart', 'image'],
  ['caption', 'caption'],
  ['document frame', 'document'],
  ['heading', 'heading'],
  ['page', 'group'],
  ['section', 'generic'],
  ['redundant object', 'generic'],
  ['form', 'form'],
  ['link', 'link'],
  ['input method window', 'window'],
  ['table row', 'row'],
  ['tree item', 'treeitem'],
  ['document spreadsheet', 'document'],
  ['document presentation', 'document'],
  ['document text', 'document'],
  ['document web', 'document'],
  ['document email', 'document'],
  ['comment', 'note'],
  ['list box', 'listbox'],
  ['grouping', 'group'],
  ['image map', 'image'],
  ['notification', 'alert'],
  ['info bar', 'status'],
  ['level bar', 'meter'],
  ['title bar', 'titlebar'],
  ['block quote', 'blockquote'],
  ['audio', 'audio'],
  ['video', 'video'],
  ['definition', 'definition'],
  ['article', 'article'],
  ['landmark', 'region'],
  ['log', 'log'],
  ['marquee', 'status'],
  ['math', 'math'],
  ['rating', 'slider'],
  ['timer', 'timer'],
  ['static', 'text'],
  ['math fraction', 'math'],
  ['math root', 'math'],
  ['subscript', 'generic'],
  ['superscript', 'generic'],
  ['description list', 'list'],
  ['description term', 'term'],
  ['description value', 'definition'],
  ['footnote', 'note'],
  ['content deletion', 'generic'],
  ['content insertion', 'generic'],
  ['mark', 'generic'],
  ['suggestion', 'generic'],
  ['push button menu', 'button'],
  ['switch', 'switch'],
];

export const ROLE = {
  INVALID: 0,
  CHECK_BOX: 7,
  CHECK_MENU_ITEM: 8,
  COMBO_BOX: 11,
  DIALOG: 16,
  FRAME: 23,
  LABEL: 29,
  MENU: 33,
  MENU_ITEM: 35,
  PANEL: 39,
  PASSWORD_TEXT: 40,
  PUSH_BUTTON: 43,
  RADIO_BUTTON: 44,
  TEXT: 61,
  TOGGLE_BUTTON: 62,
  WINDOW: 69,
  APPLICATION: 75,
  PUSH_BUTTON_MENU: 129,
} as const;

export function nativeRoleName(role: number): string {
  return ROLE_TABLE[role]?.[0] ?? `role ${role}`;
}

export function normalizedRole(role: number): Role {
  return ROLE_TABLE[role]?.[1] ?? 'unknown';
}

// AtspiStateType bit positions.
export const STATE = {
  INVALID: 0, ACTIVE: 1, ARMED: 2, BUSY: 3, CHECKED: 4, COLLAPSED: 5, DEFUNCT: 6, EDITABLE: 7,
  ENABLED: 8, EXPANDABLE: 9, EXPANDED: 10, FOCUSABLE: 11, FOCUSED: 12, HAS_TOOLTIP: 13,
  HORIZONTAL: 14, ICONIFIED: 15, MODAL: 16, MULTI_LINE: 17, MULTISELECTABLE: 18, OPAQUE: 19,
  PRESSED: 20, RESIZABLE: 21, SELECTABLE: 22, SELECTED: 23, SENSITIVE: 24, SHOWING: 25,
  SINGLE_LINE: 26, STALE: 27, TRANSIENT: 28, VERTICAL: 29, VISIBLE: 30, MANAGES_DESCENDANTS: 31,
  INDETERMINATE: 32, REQUIRED: 33, TRUNCATED: 34, ANIMATED: 35, INVALID_ENTRY: 36,
  SUPPORTS_AUTOCOMPLETION: 37, SELECTABLE_TEXT: 38, IS_DEFAULT: 39, VISITED: 40, CHECKABLE: 41,
  HAS_POPUP: 42, READ_ONLY: 43,
} as const;

const STATE_MAP: [bit: number, state: State][] = [
  [STATE.ACTIVE, 'active'],
  [STATE.BUSY, 'busy'],
  [STATE.CHECKED, 'checked'],
  [STATE.COLLAPSED, 'collapsed'],
  [STATE.DEFUNCT, 'defunct'],
  [STATE.EDITABLE, 'editable'],
  [STATE.EXPANDABLE, 'expandable'],
  [STATE.EXPANDED, 'expanded'],
  [STATE.FOCUSABLE, 'focusable'],
  [STATE.FOCUSED, 'focused'],
  [STATE.HORIZONTAL, 'horizontal'],
  [STATE.ICONIFIED, 'minimized'],
  [STATE.MODAL, 'modal'],
  [STATE.MULTI_LINE, 'multiline'],
  [STATE.MULTISELECTABLE, 'multiselectable'],
  [STATE.PRESSED, 'pressed'],
  [STATE.SELECTABLE, 'selectable'],
  [STATE.SELECTED, 'selected'],
  [STATE.SHOWING, 'showing'],
  [STATE.TRANSIENT, 'transient'],
  [STATE.VERTICAL, 'vertical'],
  [STATE.INDETERMINATE, 'mixed'],
  [STATE.REQUIRED, 'required'],
  [STATE.INVALID_ENTRY, 'invalid'],
  [STATE.IS_DEFAULT, 'default'],
  [STATE.VISITED, 'visited'],
  [STATE.CHECKABLE, 'checkable'],
  [STATE.HAS_POPUP, 'haspopup'],
  [STATE.READ_ONLY, 'readonly'],
];

export function hasStateBit(bits: number[], bit: number): boolean {
  return ((bits[bit >> 5] ?? 0) >>> (bit & 31)) & 1 ? true : false;
}

/** Translate an AT-SPI state set (two uint32s) into normalized states for a node of `role`. */
export function normalizeStates(bits: number[], role: number): Set<State> {
  const states = new Set<State>();
  for (const [bit, state] of STATE_MAP) if (hasStateBit(bits, bit)) states.add(state);
  // GTK3 and Qt set both ENABLED and SENSITIVE, GTK4 only SENSITIVE; disabled widgets have neither.
  if (hasStateBit(bits, STATE.ENABLED) || hasStateBit(bits, STATE.SENSITIVE)) states.add('enabled');
  if (role === ROLE.TOGGLE_BUTTON && states.has('checked')) {
    states.delete('checked');
    states.add('pressed');
  }
  if (role === ROLE.PASSWORD_TEXT) states.add('protected');
  if (role === ROLE.CHECK_BOX || role === ROLE.RADIO_BUTTON || role === ROLE.CHECK_MENU_ITEM || role === ROLE.TOGGLE_BUTTON) {
    states.add('checkable');
  }
  // A text role without EDITABLE is read-only, even if the toolkit doesn't say so.
  if (role === ROLE.TEXT && !states.has('editable')) states.add('readonly');
  return states;
}

const RELATIONS: (RelationType | null)[] = [
  null, 'labelFor', 'labelledBy', 'controllerFor', 'controlledBy', 'memberOf', 'tooltipFor',
  'nodeChildOf', 'nodeParentOf', 'extended', 'flowsTo', 'flowsFrom', 'subwindowOf', 'embeds',
  'embeddedBy', 'popupFor', 'parentWindowOf', 'descriptionFor', 'describedBy', 'details',
  'detailsFor', 'errorMessage', 'errorFor',
];

export function relationType(n: number): RelationType | null {
  return RELATIONS[n] ?? null;
}

const CAPABILITIES: Record<string, Capability> = {
  'org.a11y.atspi.Action': 'action',
  'org.a11y.atspi.Text': 'text',
  'org.a11y.atspi.EditableText': 'editableText',
  'org.a11y.atspi.Value': 'value',
  'org.a11y.atspi.Selection': 'selection',
  'org.a11y.atspi.Component': 'component',
  'org.a11y.atspi.Table': 'table',
  'org.a11y.atspi.Image': 'image',
  'org.a11y.atspi.Hyperlink': 'hyperlink',
  'org.a11y.atspi.Document': 'document',
};

export function capabilitiesOf(interfaces: string[]): Set<Capability> {
  const caps = new Set<Capability>();
  for (const iface of interfaces) {
    const cap = CAPABILITIES[iface];
    if (cap) caps.add(cap);
  }
  return caps;
}

export const COORD_TYPE = { SCREEN: 0, WINDOW: 1, PARENT: 2 } as const;
export const SCROLL_ANYWHERE = 6;
