# northbridge

y'all are overthinking computer use

Every desktop app already describes itself to screen readers: what's on screen, what each thing is
called, whether it's checked or disabled, and how to press it. northbridge hands you that
accessibility tree as an API. It's Puppeteer for the whole desktop: test your own apps with
locators and auto-waiting assertions, or let an agent use the computer through text instead of
screenshots and pixel coordinates.

```ts
import { connect, expect } from 'northbridge';

const desktop = await connect();
const calc = await desktop.launch('gnome-calculator');

for (const key of ['6', '×', '7', '=']) {
  await calc.getByRole('button', { name: key }).click();
}
await expect(calc.getByRole('textbox').first()).toHaveText('42');
```

The same, from a shell (or an agent's shell):

```console
$ northbridge launch gnome-calculator
Launched gnome-calculator (pid 5832)
- application "gnome-calculator" [ref=e1]:
  - window "Calculator" [active] [ref=e2]:
    - list [ref=e3]
    - textbox [focused] [ref=e4]
    - textbox [readonly] [ref=e5]
    - button "7" [ref=e7]
    - button "1" [ref=e14]
    - button "×" [desc="Multiply [*]"] [ref=e19]
    - button "=" [desc="Calculate Result"] [ref=e29]
    - button "Main Menu" [haspopup] [ref=e32]
    …

$ northbridge click 'button "7"'
Clicked button "7" [ref=e7]
~ textbox [focused] [ref=e4]: "7"  (was: textbox [focused] [ref=e4])
~ button "Undo" [ref=e30]  (was: button "Undo" [disabled] [ref=e30])

$ northbridge click 'button "×"'
Clicked button "×" [desc="Multiply [*]"] [ref=e19]
~ textbox [focused] [ref=e4]: "7×"  (was: textbox [focused] [ref=e4]: "7")

$ northbridge click e14
Clicked button "1" [ref=e14]
~ textbox [focused] [ref=e4]: "7×1"  (was: textbox [focused] [ref=e4]: "7×")

$ northbridge press Enter
Pressed Enter
+ listitem [ref=e36]
+   text "7×1" [ref=e37]
+   text "=" [ref=e38]
+   text "7" [ref=e39]
~ textbox [focused] [ref=e4]: "7"  (was: textbox [focused] [ref=e4]: "7×1")
```

Every action tells you what it did and what changed: `+` appeared, `-` went away, `~` changed.
The refs (`e14`) stay attached to the same element for as long as it exists, so you can act on what
you saw a moment ago without asking for the whole screen again.

## Why

Screenshot-driven computer use has a model squint at pixels, guess coordinates, and hope the
window didn't move. The accessibility tree already knows that the thing at (316, 502) is a button
named "7", that it's enabled, and that it has a `click` action. northbridge talks to it directly:

- **Text in, text out.** A snapshot of a window is a few hundred tokens of YAML-ish text, not a
  megapixel image. Results come back as text too.
- **Semantic actions.** `click()` runs the button's own accessibility action when that's reliable
  for the toolkit, so it works on covered windows and doesn't care where anything is drawn. It
  falls back to a real pointer click when that's safer.
- **Stable handles.** Refs and role/name selectors survive layout changes, themes, scaling and
  resizing, none of which screenshots survive.
- **No dependencies.** It's pure TypeScript. D-Bus and X11 are spoken directly over their sockets:
  no native modules, no Python bindings, no xdotool.

## Install

```sh
npm install northbridge        # library, CLI and MCP server
npx northbridge --help
```

Linux needs the AT-SPI accessibility bus (`at-spi2-core`), which every GNOME, KDE and Xfce desktop
already runs. northbridge turns the desktop's accessibility switch on when it connects, so Qt and
Chromium apps expose their trees too. Node 20 or newer.

## Testing your app

Locators find elements the way people describe them, re-query the live tree every time, wait for
elements to appear and become enabled, and refuse to guess when several things match.

```ts
import { test, after } from 'node:test';
import { connect, expect } from 'northbridge';

const desktop = await connect();
after(() => desktop.close()); // also closes apps it launched

test('signs up', async () => {
  const app = await desktop.launch(['./build/my-app', '--fresh-profile']);

  await app.getByLabel('Name').fill('Ada Lovelace');
  await app.getByRole('textbox', { name: 'Email' }).fill('ada@example.com');
  await app.getByRole('checkbox', { name: 'Subscribe to newsletter' }).check();
  await app.getByLabel('Plan').selectOption('Pro');
  await app.getById('submit').click();               // AccessibleId / AXIdentifier / AutomationId

  await expect(app.getByRole('dialog', { name: 'Welcome' })).toBeVisible();
  await expect(app.getById('status')).toHaveText(/^Signed up/);
});
```

Run it headless, in CI or on your own machine without anything popping up:

```sh
npx northbridge headless -- node --test     # Xvfb + private D-Bus + AT-SPI, torn down afterwards
```

When something isn't found, the error says what is there:

```
TimeoutError: Timed out after 5000ms waiting for button "Submt" in application "my-app" [ref=e1]
to be visible and enabled: no element matched.
Similar elements:
  - button "Submit" [id="submit"] [ref=e8]
```

```
StrictModeError: radio matched 3 elements; narrow it down (by name, .first(), .nth(i)) or use a ref:
  - radio "Small" [ref=e18]
  - radio "Medium" [checked] [ref=e19]
  - radio "Large" [ref=e20]
```

Give your own widgets accessible ids (`gtk_accessible_set_accessible_id`, Qt `objectName`,
`accessibilityIdentifier` on macOS, `AutomationId` on Windows) and you get stable test hooks that
cost real users nothing. That's the desktop's `data-testid`.

## For agents

### MCP

```sh
claude mcp add northbridge -- npx -y northbridge mcp
```

Or in any MCP client's config:

```json
{ "mcpServers": { "northbridge": { "command": "npx", "args": ["-y", "northbridge", "mcp"] } } }
```

Tools: `snapshot`, `list_apps`, `find`, `read`, `click`, `fill`, `type`, `press_keys`,
`set_checked`, `select_option`, `set_value`, `invoke_action`, `wait_for`, `scroll`, `hover`,
`mouse`, `screenshot`, `focused_element`, `launch_app`, `close_app`. Each action returns what
changed, so an agent sees the dialog it just opened without another round trip.

### CLI

Anything that can run shell commands can use the CLI. Refs carry over from one command to the
next.

```
snapshot [target] [-i]       the screen as text; -i lists only what you can act on
apps / find / get / focused  look around
click / fill / type / press / check / select / set / invoke / hover / scroll    act
launch / close               manage apps
screenshot [target] -o f.png for things the tree doesn't describe (canvases, images)
```

`northbridge --help` has the details.

## The snapshot format

```
- window "Northbridge Fixture" [active] [ref=e2]:
  - menubar [ref=e3]:
    - menu "File" [ref=e4]
  - tablist [ref=e6]:
    - tab "Form" [selected] [ref=e7]:
      - textbox "Name" [id="name-field"] [ref=e24]: "Ada Lovelace"
      - textbox "Password" [protected] [ref=e22]
      - checkbox "Subscribe to newsletter" [checked] [ref=e21]
      - radio "Medium" [checked] [ref=e19]
      - combobox "Red" [ref=e16]
      - spinbutton "Quantity" [ref=e15]: 1
      - slider "Volume" [ref=e14]: 50
      - button "Unavailable" [disabled] [ref=e10]
      - button "Delete…" [ref=e11]
  - text "Ready" [id="status"] [ref=e27]
```

`role "name" [states] [ref=…]: value`. Roles are normalized to an ARIA-like vocabulary (`button`,
`textbox`, `checkbox`, `menuitem`, `tab`, `listitem`, `cell`, `dialog`, …) whatever the toolkit
calls them. Unnamed wrapper containers are flattened, labels that repeat their control's name are
dropped, and controls are named after the labels that point at them.

## Selectors

Selectors read like snapshot lines, so you can point at what you see. A whole pasted snapshot
line works too.

| Selector | Matches |
| --- | --- |
| `button "Save"` | role and accessible name: the whole name, ignoring case and extra whitespace |
| `"Save"` | any role with that name |
| `button /save/i` | name by regular expression |
| `button "Save"s` | case-sensitive |
| `checkbox [checked]`, `button [disabled]`, `[checked=false]` | states: `checked`, `disabled`, `focused`, `selected`, `expanded`, `pressed`, `editable`, `readonly`, `required`, `modal`, `active`, … |
| `[name*="sav"]`, `[name^="Sa"]`, `[name$="ve"]` | name contains / starts / ends |
| `[label="Email"]`, `[description="…"]`, `[text*="…"]` | label, description, text contents |
| `#submit` or `[id="submit"]` | accessible id |
| `@e12`, `e12` | a ref from a snapshot |
| `dialog "Confirm" >> button "OK"` | inside (a space works too) |
| `window > button` | direct child (unnamed wrappers don't count as a level) |
| `listitem:has-text("Inbox")`, `list:has(listitem [selected])` | filters |
| `button:first`, `:last`, `:nth(2)` | position |
| `:text("hello")`, `:text-is("Hello")` | text contents, contains or exact |
| `:hidden`, `:any-visibility` | include elements that aren't showing |
| `textbox "Email", textbox "Phone"` | either |

## API

```ts
const desktop = await connect({ timeout: 5000 });

// apps
await desktop.apps();                               // App[]
await desktop.app('Calculator');                    // by name, window title or process; waits
await desktop.app({ pid: 1234 });
const app = await desktop.launch('gedit notes.txt', { env, cwd, timeout, name, detached });
await app.windows();  app.window('Untitled');  await app.close();

// finding: on desktop, app, element or locator
x.getByRole('button', { name: 'Save', exact, checked, disabled, expanded, pressed, selected, includeHidden })
x.getByText('Welcome back', { exact })              // substring by default; innermost element
x.getByLabel('Email')                               // controls labelled by it
x.getById('submit')
x.locator('dialog >> button "OK"')
locator.filter({ has, hasNot, hasText, hasNotText, visible }).first().last().nth(2).or(other).and(other)

// acting: waits for one visible, enabled match
await locator.click({ button, clickCount, modifiers, method: 'auto' | 'action' | 'mouse', position });
await locator.dblclick();  await locator.hover();  await locator.focus();
await locator.fill('text');  await locator.clear();  await locator.type('more', { delay });
await locator.press('Control+s');
await locator.check();  await locator.uncheck();  await locator.setChecked(true);
await locator.selectOption('Blue' | /blu/i | { index: 2 });
await locator.setValue(42);                         // sliders, spin buttons
await locator.expand();  await locator.collapse();  await locator.scrollIntoView();
await locator.invoke('expand or contract');         // any named accessibility action

// reading
await locator.text();  await locator.name();  await locator.value();  await locator.states();
await locator.isVisible();  await locator.isChecked();  await locator.count();  await locator.all();
await locator.snapshot({ interactive });  await locator.screenshot({ path });
await locator.waitFor({ state: 'visible' | 'hidden' | 'attached' | 'detached', timeout });

// assertions retry until they pass or time out
await expect(locator).toBeVisible() / toBeHidden() / toBeEnabled() / toBeDisabled() / toBeChecked()
  / toBeFocused() / toBeEditable() / toBeSelected() / toBeExpanded() / toHaveState('busy')
  / toHaveText('…' | /…/ | [...]) / toContainText() / toHaveName() / toHaveValue(42 | '…')
  / toHaveCount(3) / toHaveRole('button') / toHaveId('submit') / toHaveDescription()
await expect(locator).not.toBeVisible();

// everything else
await desktop.snapshot({ interactive, all });       // apps, windows, the active window in full
desktop.element('e12');                             // a ref from a snapshot
await desktop.focused();  await desktop.activeWindow();
await desktop.keyboard.press('Control+Shift+t');  await desktop.keyboard.type('héllo ✓');
await desktop.mouse.click(400, 300, { button: 'right' });  await desktop.mouse.wheel(0, 3);
await desktop.screenshot({ path: 'screen.png', clip });
```

## Platforms

| | Tree and accessibility actions | Keyboard, mouse, screenshots |
| --- | --- | --- |
| Linux, X11 | ✅ AT-SPI. Tested: GTK 3, GTK 4, LibreOffice. Qt 5 works once registered (see below). Firefox, Chromium/Electron and Java speak AT-SPI too but aren't in the test suite yet | ✅ XTEST, pure TS |
| Linux, Wayland | ✅ | ❌ not yet. Compositors don't allow synthesized input without a portal; semantic actions still work |
| macOS | planned: AXUIElement backend | planned |
| Windows | planned: UI Automation backend | planned |

The core (locators, selectors, snapshots, assertions, CLI, MCP) only speaks the small
[`Backend`](src/backend.ts) interface. A platform plugs in by implementing it.

## Toolkit quirks handled for you

These are the kind of thing you'd otherwise rediscover the hard way:

- **GTK 3, Firefox, Chromium, LibreOffice** answer accessibility requests inside D-Bus dispatch. An
  action handler that opens a modal dialog (`gtk_dialog_run`) freezes the app's whole tree until
  the dialog closes. For those toolkits `click()` uses a real pointer click when input is
  available, which doesn't have the problem.
- **GTK 4** buttons emit `clicked` 250ms after an accessibility click. northbridge waits it out, so
  typing right after a click doesn't overtake it.
- **GTK 4** reports window-relative coordinates as screen coordinates, so pointer clicks are
  translated through the matching X window.
- **GTK 4.14** popover menu items carry their names on unnamed labels. They're resolved, so you get
  `menuitem "Preferences"` and not `menuitem`.
- **GTK 3** tree views ignore `Selection.SelectChild` when they have more than one column, so
  northbridge uses the Table interface instead.
- **GTK** selects a text field's contents when it gains focus. `type()` puts the caret at the end
  first, so it appends.
- **Qt 5** crashes on `Properties.GetAll`, so Qt apps are read one property at a time.
- **LibreOffice** returns no text when asked for more characters than a paragraph has; reads are
  clamped to the real length.

Known issue: a Qt 5 app started while the desktop's accessibility switch is already on may never
register with AT-SPI (a Qt bug). Apps started before `connect()`, or with the switch off, work.

## Development

```sh
npm install
npm test                    # unit tests
npm run test:integration    # drives real GTK 3 and GTK 4 apps in a throwaway Xvfb desktop
npm run typecheck
npm run nb -- snapshot      # the CLI from source
```

Integration tests need `xvfb`, `dbus-daemon`, `at-spi2-core`, `python3-gi`, `gir1.2-gtk-3.0` and
(optionally) `gnome-calculator`. Set `NORTHBRIDGE_PYTHON` if PyGObject lives in a Python other than
`python3`. Source runs directly on Node 22.18+ thanks to type stripping. The published package is
compiled JavaScript.
