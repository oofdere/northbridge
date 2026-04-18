use std::process::Command;

use crate::Error;

const READ_SCRIPT: &str = r#"
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi
Atspi.init()

def linearize(node, depth=0):
    if node is None:
        return []
    lines = []
    name = node.get_name() or ""
    role = node.get_role_name()
    states = []
    try:
        ss = node.get_state_set()
        if ss.contains(Atspi.StateType.FOCUSED):
            states.append("focused")
        if ss.contains(Atspi.StateType.SELECTED):
            states.append("selected")
        if ss.contains(Atspi.StateType.CHECKED):
            states.append("checked")
    except:
        pass

    skip_roles = {"redundant object", "separator", "filler", "section", "panel"}
    if role not in skip_roles or name:
        label = ""
        if name:
            label = name
        state_str = " (" + ", ".join(states) + ")" if states else ""
        if role in ("application", "frame", "dialog", "alert", "window"):
            label = f"{name} [{role}]{state_str}" if name else f"[{role}]{state_str}"
        elif role in ("push button", "toggle button"):
            label = f"[{name}]{state_str}" if name else f"[button]{state_str}"
        elif role in ("text",):
            try:
                ti = node.get_text()
                if ti:
                    val = ti.get_text(0, ti.get_character_count())
                    label = f'"{val}"' if val else name
            except:
                label = name
        elif role in ("label", "heading", "paragraph"):
            label = f"{name} [{role}]{state_str}" if name else ""
        elif role in ("check box",):
            label = f"[{'x' if 'checked' in states else ' '}] {name}"
        elif role in ("radio button",):
            label = f"({'*' if 'checked' in states else ' '}) {name}"
        elif role in ("combo box", "list", "menu", "menu bar", "tool bar", "tab list"):
            label = f"{name} [{role}]{state_str}" if name else f"[{role}]{state_str}"
        elif role in ("menu item", "list item", "tab"):
            label = f"  {name}{state_str}" if name else ""
        elif role in ("page tab",):
            label = f"[tab: {name}]{state_str}" if name else ""
        elif role in ("link",):
            label = f"<{name}>{state_str}" if name else ""
        elif role in ("icon",):
            label = ""
        elif name:
            label = f"{name} [{role}]{state_str}"

        if label:
            lines.append("  " * min(depth, 4) + label)

    try:
        n = node.get_child_count()
        for i in range(min(n, 50)):
            child = node.get_child_at_index(i)
            if child:
                lines.extend(linearize(child, depth + 1))
    except:
        pass
    return lines

desktop = Atspi.get_desktop(0)
focus = None
for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    if app and app.get_name():
        for j in range(min(app.get_child_count(), 10)):
            win = app.get_child_at_index(j)
            if win:
                try:
                    ss = win.get_state_set()
                    if ss.contains(Atspi.StateType.ACTIVE):
                        focus = win
                        break
                except:
                    pass
    if focus:
        break

if focus is None:
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app and app.get_child_count() > 0:
            focus = app.get_child_at_index(0)
            break

if focus:
    lines = linearize(focus)
    print("\n".join(lines))
else:
    print("[no active window]")
"#;

pub(crate) fn read_screen() -> Result<String, Error> {
    let output = Command::new("/usr/bin/python3")
        .arg("-c")
        .arg(READ_SCRIPT)
        .output()
        .map_err(|_| Error::ScreenRead)?;

    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout).to_string();
        if text.trim().is_empty() {
            Ok("[empty screen]".to_string())
        } else {
            Ok(text)
        }
    } else {
        Err(Error::ScreenRead)
    }
}
