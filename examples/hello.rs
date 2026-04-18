use northbridge::Northbridge;

fn main() -> Result<(), northbridge::Error> {
    println!("starting northbridge...");
    let mut nb = Northbridge::new()?;

    println!("reading display...");
    let text = nb.read()?;
    println!("display: {text}");

    println!("\npressing Tab...");
    nb.press_key("Tab")?;
    std::thread::sleep(std::time::Duration::from_millis(500));

    let text = nb.read()?;
    println!("display: {text}");

    Ok(())
}
