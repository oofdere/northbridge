use northbridge::Northbridge;
use std::process::Command;

fn pause(ms: u64) {
    std::thread::sleep(std::time::Duration::from_millis(ms));
}

fn main() -> Result<(), northbridge::Error> {
    let nb = Northbridge::new();

    println!("=== northbridge: opening system settings ===\n");

    // Kill any existing instance
    let _ = Command::new("pkill")
        .args(["-f", "gnome-control-center"])
        .status();
    pause(1000);

    // Launch GNOME Settings
    Command::new("gnome-control-center")
        .env("DISPLAY", ":0")
        .spawn()
        .expect("failed to launch gnome-control-center");

    pause(3000);

    // Step 1: Read the screen
    println!("--- step 1: reading screen ---");
    let screen = nb.read()?;
    println!("{screen}");

    // Step 2: Use search to find "About"
    println!("\n--- step 2: searching for 'about' ---");

    // Click the search button/icon at the top of Settings
    nb.press_key("ctrl+f")?;
    pause(500);

    // Type "about" in the search field
    nb.type_text("about")?;
    pause(1000);

    // Read search results
    let screen = nb.read()?;
    println!("{screen}");

    // Step 3: Press Enter or click the search result
    println!("\n--- step 3: pressing Enter to open About ---");
    nb.press_key("Return")?;
    pause(2000);

    // Step 4: Read the About page
    println!("\n--- step 4: reading About page ---");
    let screen = nb.read()?;
    println!("{screen}");

    println!("\n=== done ===");
    Ok(())
}
