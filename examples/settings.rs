use northbridge::Northbridge;

fn pause(ms: u64) {
    std::thread::sleep(std::time::Duration::from_millis(ms));
}

fn main() -> Result<(), northbridge::Error> {
    println!("=== northbridge: reading plasma system settings ===\n");

    // Launch KDE System Settings
    let _ = std::process::Command::new("pkill")
        .args(["-f", "systemsettings"])
        .status();
    pause(1000);

    let child = std::process::Command::new("systemsettings5")
        .env("DISPLAY", ":0")
        .spawn()
        .expect("failed to launch systemsettings5");
    // Keep child handle alive so we can kill it later
    let mut child = child;

    pause(3000);

    // Focus the window
    std::process::Command::new("xdotool")
        .args(["search", "--name", "System Settings", "windowactivate"])
        .env("DISPLAY", ":0")
        .status()
        .ok();
    pause(1000);

    println!("starting northbridge...");
    let mut nb = Northbridge::new()?;

    // Read the initial display
    println!("\n--- initial display ---");
    let text = nb.read()?;
    println!("display: {text}");

    // Tab to the sidebar list
    nb.press_key("Tab")?;
    pause(800);
    let text = nb.read()?;
    println!("sidebar: {text}");

    // Navigate all sidebar categories
    println!("\n--- sidebar categories ---");
    for i in 0..16 {
        nb.press_key("Down")?;
        pause(600);
        let text = nb.read()?;
        println!("  {}: {text}", i + 1);
    }

    // Clean up
    let _ = child.kill();

    println!("\n=== done ===");
    Ok(())
}
