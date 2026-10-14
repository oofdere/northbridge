// Linux backend: AT-SPI 2 spoken directly over D-Bus.
// https://gitlab.gnome.org/GNOME/at-spi2-core/-/tree/main/xml

import type {
  ActionInfo,
  AppHandle,
  Backend,
  InputDriver,
  NodeHandle,
  RawImage,
  Relation,
} from '../backend.ts';
import { DBusConnection, DBusError, Variant } from '../dbus/connection.ts';
import { NorthbridgeError, StaleElementError } from '../errors.ts';
import { sleep } from '../util.ts';
import type { NodeInfo, NumericValue, Rect } from '../model.ts';
import {
  capabilitiesOf,
  COORD_TYPE,
  nativeRoleName,
  normalizedRole,
  normalizeStates,
  relationType,
  ROLE,
  SCROLL_ANYWHERE,
} from './constants.ts';

export interface AtspiHandle extends NodeHandle {
  readonly bus: string;
  readonly path: string;
}

const ROOT_PATH = '/org/a11y/atspi/accessible/root';
const GTK4_ACTIVATE_DELAY = 270;
const ACTION_REPLY_GRACE = 1000;
const NULL_PATH = '/org/a11y/atspi/null';
const REGISTRY = 'org.a11y.atspi.Registry';

const IFACE = {
  Accessible: 'org.a11y.atspi.Accessible',
  Action: 'org.a11y.atspi.Action',
  Component: 'org.a11y.atspi.Component',
  EditableText: 'org.a11y.atspi.EditableText',
  Selection: 'org.a11y.atspi.Selection',
  Table: 'org.a11y.atspi.Table',
  Text: 'org.a11y.atspi.Text',
  Value: 'org.a11y.atspi.Value',
  Properties: 'org.freedesktop.DBus.Properties',
} as const;

// Errors that mean "this object (or its whole app) is gone".
const GONE_ERRORS = new Set([
  'org.freedesktop.DBus.Error.UnknownObject',
  'org.freedesktop.DBus.Error.ServiceUnknown',
  'org.freedesktop.DBus.Error.NoReply',
  'org.freedesktop.DBus.Error.Disconnected',
  'org.freedesktop.DBus.Error.NameHasNoOwner',
]);

export interface AtspiOptions {
  /** Turn on the desktop's accessibility switch so Qt, Chromium and friends expose their trees. Default true. */
  enableAccessibility?: boolean;
  /** Per-call timeout in ms for talking to applications. Default 5000. */
  callTimeout?: number;
}

export class AtspiBackend implements Backend {
  readonly name = 'atspi';
  input?: InputDriver;
  screenBounds?: Rect;
  screenshot?: (rect?: Rect) => Promise<RawImage>;
  activateWindow?: (window: NodeHandle) => Promise<boolean>;

  readonly session: DBusConnection;
  readonly a11y: DBusConnection;
  private readonly callTimeout: number;
  private readonly pids = new Map<string, Promise<number | undefined>>();
  private readonly toolkits = new Map<string, Promise<{ name: string; version: string } | null>>();
  private readonly actionNames = new Map<string, Promise<ActionInfo[]>>();

  private constructor(session: DBusConnection, a11y: DBusConnection, options: AtspiOptions) {
    this.session = session;
    this.a11y = a11y;
    this.callTimeout = options.callTimeout ?? 5000;
    // Forget per-app caches when an app leaves the bus.
    a11y.onSignal({ interface: 'org.freedesktop.DBus', member: 'NameOwnerChanged' }, (msg) => {
      const [name, , newOwner] = msg.body as string[];
      if (!newOwner) {
        this.pids.delete(name);
        for (const key of this.toolkits.keys()) if (key.startsWith(`${name}/`)) this.toolkits.delete(key);
        for (const key of this.actionNames.keys()) if (key.startsWith(`${name}/`)) this.actionNames.delete(key);
      }
    });
  }

  static async connect(options: AtspiOptions = {}): Promise<AtspiBackend> {
    let session: DBusConnection;
    try {
      session = await DBusConnection.session();
    } catch (err) {
      throw new NorthbridgeError(
        `Can't reach the D-Bus session bus, which AT-SPI needs: ${(err as Error).message}. ` +
          'Run inside a desktop session, or start one (e.g. `dbus-run-session -- <command>`).',
      );
    }
    let address: string;
    try {
      [address] = (await session.call({
        destination: 'org.a11y.Bus',
        path: '/org/a11y/bus',
        interface: 'org.a11y.Bus',
        member: 'GetAddress',
      })) as [string];
    } catch (err) {
      session.close();
      throw new NorthbridgeError(
        `The accessibility bus (org.a11y.Bus) isn't available: ${(err as Error).message}. ` +
          'Install at-spi2-core (it provides at-spi-bus-launcher).',
      );
    }
    if (options.enableAccessibility !== false) {
      try {
        const enabled = await session.getProperty('org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Status', 'IsEnabled');
        if (!enabled) {
          await session.setProperty('org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Status', 'IsEnabled', new Variant('b', true));
        }
      } catch {
        // Older bus launchers lack org.a11y.Status; GTK apps still work without it.
      }
    }
    const a11y = await DBusConnection.connect(address);
    await a11y.bus('AddMatch', 's', ["type='signal',sender='org.freedesktop.DBus',member='NameOwnerChanged'"]);
    // Let scripts exit when they are done, without an explicit close().
    session.unref();
    a11y.unref();
    return new AtspiBackend(session, a11y, options);
  }

  handle(bus: string, path: string): AtspiHandle {
    return { key: `${bus}${path}`, bus, path };
  }

  handleFromKey(key: string): AtspiHandle {
    const slash = key.indexOf('/');
    if (slash <= 0) throw new NorthbridgeError(`Not an AT-SPI element key: ${key}`);
    return this.handle(key.slice(0, slash), key.slice(slash));
  }

  private async call(
    node: NodeHandle,
    iface: string,
    member: string,
    signature = '',
    body: unknown[] = [],
    timeout = this.callTimeout,
    background = false,
  ): Promise<unknown[]> {
    const { bus, path } = node as AtspiHandle;
    try {
      return await this.a11y.call(
        { destination: bus, path, interface: iface, member, signature, body },
        { timeout, noAutoStart: true, background },
      );
    } catch (err) {
      if (err instanceof DBusError && GONE_ERRORS.has(err.type)) {
        throw new StaleElementError(`Element ${node.key} no longer exists (${err.type.split('.').pop()})`);
      }
      throw err;
    }
  }

  private async property(node: NodeHandle, iface: string, name: string): Promise<unknown> {
    const [value] = await this.call(node, IFACE.Properties, 'Get', 'ss', [iface, name]);
    return value;
  }

  private ref([bus, path]: [string, string]): AtspiHandle | null {
    if (!bus || path === NULL_PATH) return null;
    return this.handle(bus, path);
  }

  async apps(): Promise<AppHandle[]> {
    const [children] = (await this.a11y.call(
      { destination: REGISTRY, path: ROOT_PATH, interface: IFACE.Accessible, member: 'GetChildren' },
      { timeout: this.callTimeout },
    )) as [[string, string][]];
    const apps = await Promise.all(
      children.map(async (ref): Promise<AppHandle | null> => {
        const node = this.ref(ref);
        if (!node) return null;
        try {
          const [name, pid] = await Promise.all([this.property(node, IFACE.Accessible, 'Name'), this.pidOf(node)]);
          return { node, name: String(name ?? ''), pid };
        } catch {
          return null; // app went away or is hung
        }
      }),
    );
    return apps.filter((a): a is AppHandle => a !== null);
  }

  async info(node: NodeHandle): Promise<NodeInfo> {
    const [[props], [role], [stateBits], [interfaces]] = (await Promise.all([
      this.call(node, IFACE.Properties, 'GetAll', 's', [IFACE.Accessible]),
      this.call(node, IFACE.Accessible, 'GetRole'),
      this.call(node, IFACE.Accessible, 'GetState'),
      this.call(node, IFACE.Accessible, 'GetInterfaces'),
    ])) as [[Record<string, unknown>], [number], [number[]], [string[]]];
    const states = normalizeStates(stateBits, role);
    let normalized = normalizedRole(role);
    // GTK4 gives application windows the "application" role; only the app root really is one.
    if (role === ROLE.APPLICATION && (node as AtspiHandle).path !== ROOT_PATH) normalized = 'window';
    if (role === ROLE.PUSH_BUTTON_MENU) states.add('haspopup');
    return {
      role: normalized,
      nativeRole: nativeRoleName(role),
      name: String(props.Name ?? ''),
      description: String(props.Description ?? ''),
      states,
      childCount: Number(props.ChildCount ?? 0),
      id: String(props.AccessibleId ?? ''),
      capabilities: capabilitiesOf(interfaces),
    };
  }

  async children(node: NodeHandle): Promise<NodeHandle[]> {
    try {
      const [refs] = (await this.call(node, IFACE.Accessible, 'GetChildren')) as [[string, string][]];
      return refs.map((r) => this.ref(r)).filter((h): h is AtspiHandle => h !== null);
    } catch (err) {
      if (!(err instanceof DBusError && err.type === 'org.freedesktop.DBus.Error.UnknownMethod')) throw err;
      // Very old implementations: walk by index.
      const count = Number(await this.property(node, IFACE.Accessible, 'ChildCount'));
      const refs = await Promise.all(
        Array.from({ length: count }, (_, i) => this.call(node, IFACE.Accessible, 'GetChildAtIndex', 'i', [i])),
      );
      return refs.map(([r]) => this.ref(r as [string, string])).filter((h): h is AtspiHandle => h !== null);
    }
  }

  async parent(node: NodeHandle): Promise<NodeHandle | null> {
    if ((node as AtspiHandle).path === ROOT_PATH) return null;
    // Only application roots have the registry as their parent, and those returned above.
    return this.ref((await this.property(node, IFACE.Accessible, 'Parent')) as [string, string]);
  }

  appOf(node: NodeHandle): NodeHandle {
    return this.handle((node as AtspiHandle).bus, ROOT_PATH);
  }

  pidOf(app: NodeHandle): Promise<number | undefined> {
    const bus = (app as AtspiHandle).bus;
    let pid = this.pids.get(bus);
    if (!pid) {
      pid = this.a11y
        .bus('GetConnectionUnixProcessID', 's', [bus])
        .then(([p]) => p as number)
        .catch(() => undefined);
      this.pids.set(bus, pid);
    }
    return pid;
  }

  async text(node: NodeHandle, maxLength?: number): Promise<string | null> {
    try {
      const [text] = await this.call(node, IFACE.Text, 'GetText', 'ii', [0, maxLength ?? -1]);
      return String(text);
    } catch (err) {
      if (err instanceof StaleElementError) throw err;
      return null;
    }
  }

  async value(node: NodeHandle): Promise<NumericValue | null> {
    try {
      const [props] = (await this.call(node, IFACE.Properties, 'GetAll', 's', [IFACE.Value])) as [Record<string, unknown>];
      const value: NumericValue = {
        current: Number(props.CurrentValue ?? 0),
        min: Number(props.MinimumValue ?? 0),
        max: Number(props.MaximumValue ?? 0),
        step: Number(props.MinimumIncrement ?? 0),
      };
      if (typeof props.Text === 'string' && props.Text) value.text = props.Text;
      return value;
    } catch (err) {
      if (err instanceof StaleElementError) throw err;
      return null;
    }
  }

  async bounds(node: NodeHandle): Promise<Rect | null> {
    try {
      const [[x, y, width, height]] = (await this.call(node, IFACE.Component, 'GetExtents', 'u', [COORD_TYPE.SCREEN])) as [
        [number, number, number, number],
      ];
      if (width <= 0 || height <= 0 || x <= -(2 ** 30) || y <= -(2 ** 30)) return null;
      return { x, y, width, height };
    } catch (err) {
      if (err instanceof StaleElementError) throw err;
      return null;
    }
  }

  /** Bounds relative to the node's window, for toolkits (GTK4) that don't know screen positions. */
  async windowBounds(node: NodeHandle): Promise<Rect | null> {
    try {
      const [[x, y, width, height]] = (await this.call(node, IFACE.Component, 'GetExtents', 'u', [COORD_TYPE.WINDOW])) as [
        [number, number, number, number],
      ];
      if (width <= 0 || height <= 0) return null;
      return { x, y, width, height };
    } catch {
      return null;
    }
  }

  /** The app's UI toolkit ("GTK" 4.14.5, "Qt" …), cached per app. */
  toolkit(node: NodeHandle): Promise<{ name: string; version: string } | null> {
    const app = this.appOf(node);
    let toolkit = this.toolkits.get(app.key);
    if (!toolkit) {
      toolkit = this.fetchToolkit(app);
      this.toolkits.set(app.key, toolkit);
    }
    return toolkit;
  }

  private async fetchToolkit(app: NodeHandle): Promise<{ name: string; version: string } | null> {
    try {
      const [props] = (await this.call(this.appOf(app), IFACE.Properties, 'GetAll', 's', ['org.a11y.atspi.Application'])) as [
        Record<string, unknown>,
      ];
      return { name: String(props.ToolkitName ?? ''), version: String(props.Version ?? '') };
    } catch {
      try {
        const name = await this.property(this.appOf(app), 'org.a11y.atspi.Application', 'ToolkitName');
        return { name: String(name), version: '' };
      } catch {
        return null;
      }
    }
  }

  actions(node: NodeHandle): Promise<ActionInfo[]> {
    // Action sets are fixed per object, so remember them.
    let actions = this.actionNames.get(node.key);
    if (!actions) {
      actions = this.fetchActions(node);
      this.actionNames.set(node.key, actions);
      actions.catch(() => this.actionNames.delete(node.key));
      if (this.actionNames.size > 5000) this.actionNames.clear();
    }
    return actions;
  }

  private async fetchActions(node: NodeHandle): Promise<ActionInfo[]> {
    let list: [string, string, string][];
    try {
      [list] = (await this.call(node, IFACE.Action, 'GetActions')) as [[string, string, string][]];
    } catch (err) {
      if (err instanceof StaleElementError) throw err;
      return [];
    }
    // GetActions reports localized names; GetName gives the stable programmatic one.
    const names = await Promise.all(
      list.map((_, i) =>
        this.call(node, IFACE.Action, 'GetName', 'i', [i]).then(
          ([n]) => String(n),
          () => '',
        ),
      ),
    );
    return list.map(([localized, description, keybinding], i) => ({
      name: names[i] || localized,
      description,
      keybinding,
    }));
  }

  async attributes(node: NodeHandle): Promise<Record<string, string>> {
    try {
      const [attrs] = (await this.call(node, IFACE.Accessible, 'GetAttributes')) as [Record<string, string>];
      return { ...attrs };
    } catch (err) {
      if (err instanceof StaleElementError) throw err;
      return {};
    }
  }

  async relations(node: NodeHandle): Promise<Relation[]> {
    try {
      const [set] = (await this.call(node, IFACE.Accessible, 'GetRelationSet')) as [[number, [string, string][]][]];
      const out: Relation[] = [];
      for (const [type, targets] of set) {
        const t = relationType(type);
        if (!t) continue;
        out.push({ type: t, targets: targets.map((r) => this.ref(r)).filter((h): h is AtspiHandle => h !== null) });
      }
      return out;
    } catch (err) {
      if (err instanceof StaleElementError) throw err;
      return [];
    }
  }

  async indexInParent(node: NodeHandle): Promise<number> {
    const [index] = await this.call(node, IFACE.Accessible, 'GetIndexInParent');
    return Number(index);
  }

  async doAction(node: NodeHandle, index: number): Promise<boolean> {
    // Toolkits run the action's handler before replying. If that handler opens a modal dialog
    // (gtk_dialog_run), the reply only comes once the dialog closes, so don't wait for it forever.
    const reply = this.call(node, IFACE.Action, 'DoAction', 'i', [index], 10 * 60_000, true).then(([ok]) => Boolean(ok));
    const result = await Promise.race([reply, sleep(ACTION_REPLY_GRACE).then(() => 'running' as const)]);
    if (result === 'running') {
      reply.catch(() => {});
      return true;
    }
    if (result && (await this.activatesLater(node, index).catch(() => false))) await sleep(GTK4_ACTIVATE_DELAY);
    return result;
  }

  /**
   * GTK 4 buttons answer the "click" action with gtk_widget_activate(), which shows the button
   * pressed for 250ms and only then emits "clicked". Wait it out, so whatever comes next (typing,
   * reading, another click) happens after the click really did.
   */
  private async activatesLater(node: NodeHandle, index: number): Promise<boolean> {
    const toolkit = await this.toolkit(node);
    if (!toolkit || toolkit.name.toUpperCase() !== 'GTK' || !toolkit.version.startsWith('4.')) return false;
    const [actions, info] = await Promise.all([this.actions(node), this.info(node)]);
    return actions[index]?.name.toLowerCase() === 'click' && (info.nativeRole === 'push button' || info.nativeRole === 'toggle button');
  }

  async setText(node: NodeHandle, text: string): Promise<boolean> {
    const [ok] = await this.call(node, IFACE.EditableText, 'SetTextContents', 's', [text]);
    return Boolean(ok);
  }

  async insertText(node: NodeHandle, position: number, text: string): Promise<boolean> {
    const [ok] = await this.call(node, IFACE.EditableText, 'InsertText', 'isi', [position, text, Buffer.byteLength(text)]);
    return Boolean(ok);
  }

  async caretOffset(node: NodeHandle): Promise<number> {
    return Number(await this.property(node, IFACE.Text, 'CaretOffset'));
  }

  async setValue(node: NodeHandle, value: number): Promise<boolean> {
    await this.call(node, IFACE.Properties, 'Set', 'ssv', [IFACE.Value, 'CurrentValue', new Variant('d', value)]);
    return true;
  }

  async focus(node: NodeHandle): Promise<boolean> {
    const [ok] = await this.call(node, IFACE.Component, 'GrabFocus');
    return Boolean(ok);
  }

  async scrollIntoView(node: NodeHandle): Promise<boolean> {
    try {
      const [ok] = await this.call(node, IFACE.Component, 'ScrollTo', 'u', [SCROLL_ANYWHERE]);
      return Boolean(ok);
    } catch (err) {
      if (err instanceof StaleElementError) throw err;
      return false;
    }
  }

  async selectChild(container: NodeHandle, childIndex: number): Promise<boolean> {
    const [ok] = await this.call(container, IFACE.Selection, 'SelectChild', 'i', [childIndex]);
    return Boolean(ok);
  }

  async deselectChild(container: NodeHandle, childIndex: number): Promise<boolean> {
    const [ok] = await this.call(container, IFACE.Selection, 'DeselectChild', 'i', [childIndex]);
    return Boolean(ok);
  }

  async selectTableRow(table: NodeHandle, childIndex: number): Promise<boolean> {
    const [row] = await this.call(table, IFACE.Table, 'GetRowAtIndex', 'i', [childIndex]);
    if (Number(row) < 0) return false;
    const [ok] = await this.call(table, IFACE.Table, 'AddRowSelection', 'i', [row]);
    return Boolean(ok);
  }

  async setCaret(node: NodeHandle, offset: number): Promise<boolean> {
    const [ok] = await this.call(node, IFACE.Text, 'SetCaretOffset', 'i', [offset]);
    return Boolean(ok);
  }

  async prefersPointerClicks(node: NodeHandle): Promise<boolean> {
    // GTK 4 and Qt answer accessibility requests from their own event loops; everything that
    // goes through the ATK bridge (GTK 3, Firefox, Chromium, LibreOffice, Java) does not.
    const toolkit = await this.toolkit(node);
    if (!toolkit) return true;
    const name = toolkit.name.toUpperCase();
    if (name === 'QT') return false;
    if (name === 'GTK' && toolkit.version.startsWith('4.')) return false;
    return true;
  }

  launchEnvironment(): Record<string, string> {
    return {
      // GTK2/3 and Firefox load the AT-SPI bridge; Qt exposes its tree; Chromium/Electron too.
      GNOME_ACCESSIBILITY: '1',
      QT_ACCESSIBILITY: '1',
      QT_LINUX_ACCESSIBILITY_ALWAYS_ON: '1',
      ACCESSIBILITY_ENABLED: '1',
    };
  }

  async close(): Promise<void> {
    this.a11y.close();
    this.session.close();
  }
}
