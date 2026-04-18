use std::process::Command;

use crate::Error;

pub(crate) fn press_key(key: &str) -> Result<(), Error> {
    let status = Command::new("xdotool")
        .arg("key")
        .arg(key)
        .status()
        .map_err(|_| Error::Input)?;

    if status.success() {
        Ok(())
    } else {
        Err(Error::Input)
    }
}

pub(crate) fn type_text(text: &str) -> Result<(), Error> {
    let status = Command::new("xdotool")
        .arg("type")
        .arg("--clearmodifiers")
        .arg(text)
        .status()
        .map_err(|_| Error::Input)?;

    if status.success() {
        Ok(())
    } else {
        Err(Error::Input)
    }
}

pub(crate) fn click_at(x: i32, y: i32) -> Result<(), Error> {
    let status = Command::new("xdotool")
        .args(["mousemove", "--sync", &x.to_string(), &y.to_string()])
        .status()
        .map_err(|_| Error::Input)?;

    if !status.success() {
        return Err(Error::Input);
    }

    let status = Command::new("xdotool")
        .args(["click", "1"])
        .status()
        .map_err(|_| Error::Input)?;

    if status.success() {
        Ok(())
    } else {
        Err(Error::Input)
    }
}

const CLICK_SCRIPT: &str = r#"
import sys, subprocess, gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi
Atspi.init()

target = sys.argv[1]

def try_click(node):
    name = node.get_name() or ""
    role = node.get_role_name()
    # Try the action interface first
    try:
        ai = node.get_action_iface()
        if ai and ai.get_n_actions() > 0:
            for i in range(ai.get_n_actions()):
                aname = ai.get_action_name(i)
                if aname in ("click", "activate", "press", "toggle"):
                    ai.do_action(i)
                    print(f"clicked: {name} [{role}]")
                    return True
            ai.do_action(0)
            print(f"action[0]: {name} [{role}]")
            return True
    except:
        pass
    # Fall back to mouse click via component position
    try:
        comp = node.get_component()
        if comp:
            pos = comp.get_position(Atspi.CoordType.SCREEN)
            size = comp.get_size()
            x = pos.x + size.x // 2
            y = pos.y + size.y // 2
            if x > 0 and y > 0:
                subprocess.run(["xdotool", "mousemove", "--sync", str(x), str(y)])
                subprocess.run(["xdotool", "click", "1"])
                print(f"mouse click: {name} [{role}] at ({x},{y})")
                return True
    except:
        pass
    return False

def find_and_click(node, target, depth=0):
    if node is None or depth > 15:
        return False
    name = node.get_name() or ""
    if name and target.lower() in name.lower():
        # Try clicking this node
        if try_click(node):
            return True
        # Try clicking the parent (e.g. label inside a list row)
        try:
            parent = node.get_parent()
            if parent and try_click(parent):
                return True
        except:
            pass
    try:
        for i in range(min(node.get_child_count(), 100)):
            child = node.get_child_at_index(i)
            if find_and_click(child, target, depth + 1):
                return True
    except:
        pass
    return False

desktop = Atspi.get_desktop(0)
found = False
for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    if app:
        for j in range(min(app.get_child_count(), 10)):
            win = app.get_child_at_index(j)
            if win and find_and_click(win, target):
                found = True
                break
    if found:
        break

if not found:
    print(f"not found: {target}")
    sys.exit(1)
"#;

pub(crate) fn click_by_name(target: &str) -> Result<String, Error> {
    let output = Command::new("/usr/bin/python3")
        .arg("-c")
        .arg(CLICK_SCRIPT)
        .arg(target)
        .output()
        .map_err(|_| Error::Input)?;

    let result = String::from_utf8_lossy(&output.stdout).to_string();
    if output.status.success() {
        Ok(result)
    } else {
        Err(Error::ClickNotFound(target.to_string()))
    }
}
