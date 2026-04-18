# northbridge

y'all are overthinking computer use

northbridge is a virtual braille display and keyboard. it connects to BRLTTY via BrlAPI, receives text from the screen reader, and sends commands back. text in, text out.

## why

an agent is effectively deafblind. it can't see screenshots, it can't hear speech synthesis. the only interface that works is text — which is exactly what braille displays provide. northbridge is a braille display for agents.

screen readers already linearize the GUI into text. northbridge doesn't rebuild that. it just receives what the screen reader produces and relays it.

## usage

```rust
use northbridge::Northbridge;
use std::time::Duration;

fn main() -> Result<(), northbridge::Error> {
    let nb = Northbridge::connect()?;

    let (w, h) = nb.display_size();
    println!("{w}x{h} cells");

    nb.write("hello from northbridge")?;

    if let Some(key) = nb.read_key(Duration::from_secs(1))? {
        println!("got key: {key:?}");
    }

    Ok(())
}
```

## requirements

- BRLTTY daemon running (`sudo systemctl start brltty`)
- `libbrlapi-dev` (Ubuntu/Debian) or `brlapi-devel` (Fedora)

## building

```
cargo build
```

## license

MIT OR Apache-2.0
