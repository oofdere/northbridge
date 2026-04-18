use northbridge::Northbridge;
use std::time::Duration;

fn main() -> Result<(), northbridge::Error> {
    println!("connecting to BRLTTY...");
    let nb = Northbridge::connect()?;

    let (w, h) = nb.display_size();
    println!("display: {w}x{h} cells");

    nb.write("hello from northbridge")?;
    println!("wrote text to display");

    println!("waiting for a key press (1s)...");
    match nb.read_key(Duration::from_secs(1))? {
        Some(key) => println!("got key: {key:?}"),
        None => println!("no key pressed"),
    }

    Ok(())
}
