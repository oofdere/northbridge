// The contract between the platform-independent core and a platform accessibility API.
// Linux implements it over AT-SPI (D-Bus); macOS (AX) and Windows (UIA) slot in the same way.

import type { NodeInfo, NumericValue, Point, Rect } from './model.ts';

/** An opaque reference to one accessible object. `key` is unique and stable for the object's lifetime. */
export interface NodeHandle {
  readonly key: string;
}

export interface AppHandle {
  node: NodeHandle;
  name: string;
  pid?: number;
}

export type RelationType =
  | 'labelledBy' | 'labelFor' | 'describedBy' | 'descriptionFor' | 'controllerFor' | 'controlledBy'
  | 'memberOf' | 'flowsTo' | 'flowsFrom' | 'popupFor' | 'embeds' | 'embeddedBy' | 'subwindowOf'
  | 'parentWindowOf' | 'tooltipFor' | 'nodeChildOf' | 'nodeParentOf' | 'details' | 'detailsFor'
  | 'errorMessage' | 'errorFor' | 'extended';

export interface Relation {
  type: RelationType;
  targets: NodeHandle[];
}

export interface ActionInfo {
  name: string;
  description: string;
  keybinding: string;
}

export type MouseButton = 'left' | 'middle' | 'right';

/** Synthesized keyboard and mouse input. Keys use northbridge key names (see keys.ts). */
export interface InputDriver {
  keyDown(key: string): Promise<void>;
  keyUp(key: string): Promise<void>;
  /** Type literal text. Implementations handle characters that aren't on the keyboard. */
  typeText(text: string, delay?: number): Promise<void>;
  mouseMove(x: number, y: number): Promise<void>;
  mouseDown(button: MouseButton): Promise<void>;
  mouseUp(button: MouseButton): Promise<void>;
  /** Scroll by whole wheel steps; positive dy scrolls down, positive dx scrolls right. */
  scroll(dx: number, dy: number): Promise<void>;
  pointer(): Promise<Point>;
}

export interface RawImage {
  width: number;
  height: number;
  /** Tightly packed RGBA pixels. */
  data: Buffer;
}

export interface Backend {
  readonly name: string;

  apps(): Promise<AppHandle[]>;
  info(node: NodeHandle): Promise<NodeInfo>;
  children(node: NodeHandle): Promise<NodeHandle[]>;
  parent(node: NodeHandle): Promise<NodeHandle | null>;
  /** The application object a node belongs to. */
  appOf(node: NodeHandle): NodeHandle;
  pidOf(app: NodeHandle): Promise<number | undefined>;

  text(node: NodeHandle, maxLength?: number): Promise<string | null>;
  value(node: NodeHandle): Promise<NumericValue | null>;
  /** Bounds in screen coordinates, or null when unknown. */
  bounds(node: NodeHandle): Promise<Rect | null>;
  actions(node: NodeHandle): Promise<ActionInfo[]>;
  attributes(node: NodeHandle): Promise<Record<string, string>>;
  relations(node: NodeHandle): Promise<Relation[]>;
  indexInParent(node: NodeHandle): Promise<number>;

  doAction(node: NodeHandle, index: number): Promise<boolean>;
  /** Replace all text in an editable node. */
  setText(node: NodeHandle, text: string): Promise<boolean>;
  insertText(node: NodeHandle, position: number, text: string): Promise<boolean>;
  caretOffset(node: NodeHandle): Promise<number>;
  setValue(node: NodeHandle, value: number): Promise<boolean>;
  focus(node: NodeHandle): Promise<boolean>;
  scrollIntoView(node: NodeHandle): Promise<boolean>;
  selectChild(container: NodeHandle, childIndex: number): Promise<boolean>;
  deselectChild(container: NodeHandle, childIndex: number): Promise<boolean>;
  /** Select the row holding a table's `childIndex`-th child (for tables where selectChild won't). */
  selectTableRow(table: NodeHandle, childIndex: number): Promise<boolean>;
  /** Move the text caret (and clear the selection). */
  setCaret(node: NodeHandle, offset: number): Promise<boolean>;
  /**
   * Whether a real pointer click is the safer way to click this node. Toolkits that run action
   * handlers inside the accessibility request (the ATK bridge) freeze their whole accessibility
   * tree if that handler opens a modal dialog; a real click doesn't.
   */
  prefersPointerClicks(node: NodeHandle): Promise<boolean>;

  /** Recreate a handle from its key (for refs that outlive a process, e.g. in the CLI). */
  handleFromKey(key: string): NodeHandle;

  /** Raise a window and give it keyboard focus. */
  activateWindow?(window: NodeHandle): Promise<boolean>;
  input?: InputDriver;
  /** The screen area that synthesized input can reach. */
  screenBounds?: Rect;
  screenshot?(rect?: Rect): Promise<RawImage>;
  /** Environment variables that make freshly launched apps expose their accessibility tree. */
  launchEnvironment(): Record<string, string>;
  close(): Promise<void>;
}
