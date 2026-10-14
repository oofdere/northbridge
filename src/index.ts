export { connect, type ConnectOptions } from './connect.ts';
export { Desktop, type AppMatch, type DesktopSnapshotOptions, type LaunchOptions, type ScreenshotOptions } from './desktop.ts';
export { App } from './app.ts';
export { Element, type ClickOptions, type SelectOption, type TypeOptions } from './element.ts';
export {
  Locator,
  type ByRoleOptions,
  type FilterOptions,
  type RoleLike,
  type TextOptions,
  type TimeoutOptions,
  type WaitState,
} from './locator.ts';
export { Keyboard, Mouse, type MouseClickOptions } from './input.ts';
export { NorthbridgeError, NotSupportedError, StaleElementError, StrictModeError, TimeoutError } from './errors.ts';
export { SelectorError, parseSelector } from './selector.ts';
export { RefRegistry } from './refs.ts';
export type { SnapshotOptions } from './snapshot.ts';
export { ROLES, STATES, normalizeRole, type NodeInfo, type NumericValue, type Point, type Rect, type Role, type State } from './model.ts';
export type { Backend, InputDriver, MouseButton, NodeHandle, RawImage } from './backend.ts';
export { expect, Assertions, type ExpectOptions } from './expect.ts';
