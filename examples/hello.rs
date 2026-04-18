use northbridge::Northbridge;

fn main() -> Result<(), northbridge::Error> {
    let nb = Northbridge::new();

    println!("reading screen...\n");
    let screen = nb.read()?;
    println!("{screen}");

    Ok(())
}
