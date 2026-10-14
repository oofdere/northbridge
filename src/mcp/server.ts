// An MCP server (stdio transport) exposing northbridge's commands as tools.
// Spec: https://modelcontextprotocol.io/specification

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { type CommandResult, READ_PROPERTIES, type ReadProperty, Session } from '../agent/session.ts';
import { connect, type ConnectOptions } from '../connect.ts';
import type { WaitState } from '../locator.ts';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Northbridge lets you use desktop applications through their accessibility trees: the
structure screen readers use, as text. No screenshots or coordinates needed.

1. Call snapshot to see the screen. Every element has a ref like e12, stable while it exists.
2. Act on refs (or selectors): click, fill, type, press_keys, select_option, set_checked, set_value.
3. Every action reports what changed: "+" appeared, "-" disappeared, "~" changed. Usually that's all
   you need to see before the next step; take a new snapshot when you need the whole picture.

Selectors read like snapshot lines: button "Save", textbox "Email", dialog "Confirm" >> button "OK",
#some-id, checkbox [checked]. Quoted names match the whole name, ignoring case; /regex/i matches part.
Start apps with launch_app and see what's running with list_apps. Fall back to screenshot and mouse
only for things the tree doesn't describe (canvases, images, custom-drawn widgets).`;

type Args = Record<string, unknown>;

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run(session: Session, args: Args): Promise<CommandResult>;
}

const target = {
  type: 'string',
  description: 'A ref from a snapshot ("e12") or a selector such as `button "Save"`, `#submit` or `dialog "Confirm" >> button "OK"`.',
};
const app = { type: 'string', description: 'Only look inside this app (its name, a window title, or its pid). Optional.' };
const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));

const TOOLS: Tool[] = [
  {
    name: 'snapshot',
    title: 'See the screen',
    description:
      'The screen as an accessibility tree in text: every app and window, with the active window in full. Each line is ' +
      '`role "name" [states] [ref=eN]: value`. Pass a target or app to see just that, interactive to list only things ' +
      'you can act on, all to expand every window.',
    inputSchema: {
      type: 'object',
      properties: {
        target,
        app,
        interactive: { type: 'boolean', description: 'Only list elements you can interact with.' },
        all: { type: 'boolean', description: 'Expand every window instead of just the active one.' },
        include_hidden: { type: 'boolean', description: "Include elements that aren't showing (closed menus, other tabs)." },
      },
    },
    annotations: { readOnlyHint: true },
    run: (s, a) =>
      s.snapshot({ target: str(a.target), app: str(a.app), interactive: !!a.interactive, all: !!a.all, hidden: !!a.include_hidden }),
  },
  {
    name: 'list_apps',
    title: 'List apps',
    description: 'Running applications (with pids) and their windows.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run: (s) => s.apps(),
  },
  {
    name: 'find',
    title: 'Find elements',
    description: 'Every element matching a selector, one line each with its ref. Use it to pick among similar elements.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'A selector, e.g. `button` or `listitem:has-text("Inbox")`.' }, app }, required: ['selector'] },
    annotations: { readOnlyHint: true },
    run: (s, a) => s.find(String(a.selector), { app: str(a.app) }),
  },
  {
    name: 'read',
    title: 'Read a property',
    description: `Read one property of an element: ${READ_PROPERTIES.join(', ')}. "text" gives the full text of fields and documents, which snapshots truncate.`,
    inputSchema: {
      type: 'object',
      properties: { target, property: { type: 'string', enum: READ_PROPERTIES, default: 'text' }, app },
      required: ['target'],
    },
    annotations: { readOnlyHint: true },
    run: (s, a) => s.read(String(a.target), (str(a.property) ?? 'text') as ReadProperty, { app: str(a.app) }),
  },
  {
    name: 'click',
    title: 'Click',
    description:
      'Click an element. Uses its accessibility action or a real pointer click, whichever is more reliable for the app. ' +
      'Set double for a double-click, button "right" for a context menu, method "mouse" to force a real pointer click.',
    inputSchema: {
      type: 'object',
      properties: {
        target,
        app,
        double: { type: 'boolean' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        method: { type: 'string', enum: ['auto', 'action', 'mouse'] },
      },
      required: ['target'],
    },
    run: (s, a) =>
      s.click(String(a.target), {
        app: str(a.app),
        double: !!a.double,
        button: (str(a.button) ?? 'left') as 'left' | 'right' | 'middle',
        method: (str(a.method) ?? 'auto') as 'auto' | 'action' | 'mouse',
      }),
  },
  {
    name: 'fill',
    title: 'Fill a field',
    description: 'Replace the text in a text field (or set a spin button) in one step.',
    inputSchema: { type: 'object', properties: { target, text: { type: 'string' }, app }, required: ['target', 'text'] },
    annotations: { idempotentHint: true },
    run: (s, a) => s.fill(String(a.target), String(a.text ?? ''), { app: str(a.app) }),
  },
  {
    name: 'type',
    title: 'Type text',
    description:
      'Type text key by key, appending to what is there, into a target or (without one) whatever has keyboard focus. ' +
      'Set submit to press Enter afterwards.',
    inputSchema: { type: 'object', properties: { target, text: { type: 'string' }, submit: { type: 'boolean' }, app }, required: ['text'] },
    run: (s, a) => s.type(str(a.target), String(a.text ?? ''), { app: str(a.app), submit: !!a.submit }),
  },
  {
    name: 'press_keys',
    title: 'Press keys',
    description:
      'Press keys or shortcuts in order, e.g. ["Tab", "Tab", "Enter"] or ["Control+s"]. Names: Enter, Tab, Escape, Backspace, ' +
      'Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, F1–F12, Space, or a character; modifiers Control, ' +
      'Shift, Alt, Meta joined with "+". With a target, focuses it first.',
    inputSchema: {
      type: 'object',
      properties: { keys: { type: 'array', items: { type: 'string' }, minItems: 1 }, target, app },
      required: ['keys'],
    },
    run: (s, a) => {
      const keys = Array.isArray(a.keys) ? a.keys.map(String) : [String(a.keys)];
      return s.press(keys, str(a.target), { app: str(a.app) });
    },
  },
  {
    name: 'set_checked',
    title: 'Check or uncheck',
    description: 'Make a checkbox, switch, radio button, toggle button or check menu item checked (default) or unchecked.',
    inputSchema: { type: 'object', properties: { target, checked: { type: 'boolean', default: true }, app }, required: ['target'] },
    annotations: { idempotentHint: true },
    run: (s, a) => s.check(String(a.target), a.checked !== false, { app: str(a.app) }),
  },
  {
    name: 'select_option',
    title: 'Select an option',
    description: 'Pick an option in a combo box, drop-down, list or tab list, by its text (or "#2" for the third).',
    inputSchema: { type: 'object', properties: { target, option: { type: 'string' }, app }, required: ['target', 'option'] },
    annotations: { idempotentHint: true },
    run: (s, a) => s.select(String(a.target), String(a.option), { app: str(a.app) }),
  },
  {
    name: 'set_value',
    title: 'Set a value',
    description: 'Set a slider, spin button or other ranged control to a number.',
    inputSchema: { type: 'object', properties: { target, value: { type: 'number' }, app }, required: ['target', 'value'] },
    annotations: { idempotentHint: true },
    run: (s, a) => s.setValue(String(a.target), Number(a.value), { app: str(a.app) }),
  },
  {
    name: 'invoke_action',
    title: 'Run an accessibility action',
    description: 'Run one of an element\'s named accessibility actions (see read with property "actions"), e.g. "expand or contract".',
    inputSchema: { type: 'object', properties: { target, action: { type: 'string' }, app }, required: ['target', 'action'] },
    run: (s, a) => s.invoke(String(a.target), String(a.action), { app: str(a.app) }),
  },
  {
    name: 'wait_for',
    title: 'Wait for an element',
    description: 'Wait until an element is visible (default), hidden, attached or detached. Actions already wait for their target.',
    inputSchema: {
      type: 'object',
      properties: {
        target,
        state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached'] },
        timeout_ms: { type: 'number' },
        app,
      },
      required: ['target'],
    },
    annotations: { readOnlyHint: true },
    run: (s, a) => s.wait(String(a.target), (str(a.state) ?? 'visible') as WaitState, num(a.timeout_ms), { app: str(a.app) }),
  },
  {
    name: 'scroll',
    title: 'Scroll',
    description: 'Scroll with the mouse wheel over an element (or wherever the pointer is). Positive dy scrolls down, positive dx right.',
    inputSchema: { type: 'object', properties: { target, dx: { type: 'number' }, dy: { type: 'number' }, app } },
    run: (s, a) => s.scroll(str(a.target), num(a.dx) ?? 0, num(a.dy) ?? (a.dx ? 0 : 3), { app: str(a.app) }),
  },
  {
    name: 'hover',
    title: 'Hover',
    description: 'Move the pointer over an element (to show tooltips or hover menus).',
    inputSchema: { type: 'object', properties: { target, app }, required: ['target'] },
    run: (s, a) => s.hover(String(a.target), { app: str(a.app) }),
  },
  {
    name: 'mouse',
    title: 'Raw mouse input',
    description:
      'Mouse input at screen coordinates, for things the accessibility tree does not describe (canvases, drawings). ' +
      'drag takes x, y, x2, y2.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['click', 'double-click', 'move', 'down', 'up', 'drag'] },
        x: { type: 'number' },
        y: { type: 'number' },
        x2: { type: 'number' },
        y2: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
      },
      required: ['operation'],
    },
    run: (s, a) =>
      s.mouse(
        String(a.operation) as Parameters<Session['mouse']>[0],
        [a.x, a.y, a.x2, a.y2].filter((v) => v !== undefined).map(Number),
        (str(a.button) ?? 'left') as 'left' | 'right' | 'middle',
      ),
  },
  {
    name: 'screenshot',
    title: 'Screenshot',
    description: 'A PNG of the screen, an app\'s window (app) or one element (target). Use it for what the tree cannot describe.',
    inputSchema: { type: 'object', properties: { target, app } },
    annotations: { readOnlyHint: true },
    run: (s, a) => s.screenshot(str(a.target), { app: str(a.app) }),
  },
  {
    name: 'focused_element',
    title: 'Focused element',
    description: 'The element that has keyboard focus.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run: (s) => s.focused(),
  },
  {
    name: 'launch_app',
    title: 'Launch an app',
    description:
      'Start an application (e.g. "gnome-calculator" or ["firefox", "--new-window"]) and wait for its window. Returns its snapshot. ' +
      'Set name if the command hands off to another process (the app\'s name or window title).',
    inputSchema: {
      type: 'object',
      properties: {
        command: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        name: { type: 'string' },
        wait: { type: 'boolean', default: true },
      },
      required: ['command'],
    },
    annotations: { openWorldHint: true },
    run: (s, a) => {
      const command = Array.isArray(a.command) ? a.command.map(String) : String(a.command).split(/\s+/).filter(Boolean);
      return s.launch(command, { name: str(a.name), wait: a.wait !== false });
    },
  },
  {
    name: 'close_app',
    title: 'Close an app',
    description: 'Ask an application to quit (and force it after a few seconds).',
    inputSchema: { type: 'object', properties: { app: { type: 'string', description: 'App name, window title, or pid.' } }, required: ['app'] },
    annotations: { destructiveHint: true },
    run: (s, a) => s.close(String(a.app)),
  },
];

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface ServeOptions {
  version?: string;
  /** Options for connecting to the desktop (on the first tool call). */
  connect?: ConnectOptions;
  /** Streams to talk over; stdin/stdout by default. */
  stdin?: Readable;
  stdout?: Writable;
}

/** Serve MCP over stdio until the input closes. Connects to the desktop on the first tool call. */
export async function serve(options: ServeOptions = {}): Promise<void> {
  const input = options.stdin ?? process.stdin;
  const output = options.stdout ?? process.stdout;
  let session: Session | undefined;
  let connecting: Promise<Session> | undefined;
  const getSession = () => {
    connecting ??= connect(options.connect).then((desktop) => (session = new Session(desktop)));
    connecting.catch(() => {
      connecting = undefined;
    });
    return connecting;
  };
  const send = (message: object) => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  const reply = (id: JsonRpcMessage['id'], result: unknown) => send({ jsonrpc: '2.0', id, result });
  const fail = (id: JsonRpcMessage['id'], code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } });

  const handle = async (msg: JsonRpcMessage): Promise<void> => {
    const { id, method, params = {} } = msg;
    const isRequest = id !== undefined && id !== null;
    switch (method) {
      case 'initialize': {
        const requested = String(params.protocolVersion ?? '');
        reply(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'northbridge', title: 'Northbridge', version: options.version ?? '0.0.0' },
          instructions: INSTRUCTIONS,
        });
        return;
      }
      case 'ping':
        if (isRequest) reply(id, {});
        return;
      case 'tools/list':
        reply(id, { tools: TOOLS.map(({ run: _run, ...tool }) => tool) });
        return;
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) {
          fail(id, -32602, `Unknown tool: ${String(params.name)}`);
          return;
        }
        try {
          const result = await tool.run(await getSession(), (params.arguments as Args) ?? {});
          const content: object[] = [{ type: 'text', text: result.text }];
          if (result.image) content.push({ type: 'image', data: result.image.toString('base64'), mimeType: 'image/png' });
          reply(id, { content });
        } catch (err) {
          reply(id, { content: [{ type: 'text', text: Session.describeError(err) }], isError: true });
        }
        return;
      }
      default:
        if (method?.startsWith('notifications/')) return;
        if (isRequest) fail(id, -32601, `Method not found: ${method}`);
    }
  };

  // Handle one message at a time: tool calls drive one shared desktop, and order matters.
  let queue = Promise.resolve();
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let parsed: JsonRpcMessage | JsonRpcMessage[];
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(null, -32700, 'Parse error');
      continue;
    }
    for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
      queue = queue.then(() => handle(msg)).catch((err) => fail(msg.id ?? null, -32603, String(err)));
    }
  }
  await queue;
  await session?.desktop.close().catch(() => {});
}
