use northbridge::Northbridge;
use std::io::{self, BufRead, Write};

fn main() -> Result<(), northbridge::Error> {
    eprintln!("starting northbridge...");
    let mut nb = Northbridge::new()?;
    eprintln!("ready.\n");

    let stdin = io::stdin();
    let mut stdout = io::stdout();

    loop {
        print!("> ");
        stdout.flush().unwrap();

        let mut line = String::new();
        if stdin.lock().read_line(&mut line).unwrap() == 0 {
            break;
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let (cmd, arg) = match line.split_once(' ') {
            Some((c, a)) => (c, a.trim()),
            None => (line, ""),
        };

        match cmd {
            "read" | "r" => {
                let text = nb.read()?;
                println!("{text}");
            }
            "key" | "k" => {
                if arg.is_empty() {
                    eprintln!("usage: key <keyname>  (e.g. key Tab, key Down, key Return)");
                    continue;
                }
                nb.press_key(arg)?;
                std::thread::sleep(std::time::Duration::from_millis(600));
                let text = nb.read()?;
                println!("{text}");
            }
            "type" | "t" => {
                if arg.is_empty() {
                    eprintln!("usage: type <text>");
                    continue;
                }
                nb.type_text(arg)?;
                std::thread::sleep(std::time::Duration::from_millis(600));
                let text = nb.read()?;
                println!("{text}");
            }
            "wait" | "w" => {
                let ms: u64 = arg.parse().unwrap_or(1000);
                std::thread::sleep(std::time::Duration::from_millis(ms));
                let text = nb.read()?;
                println!("{text}");
            }
            "run" | "!" => {
                if arg.is_empty() {
                    eprintln!("usage: run <shell command>");
                    continue;
                }
                let output = std::process::Command::new("sh")
                    .args(["-c", arg])
                    .output();
                match output {
                    Ok(o) => {
                        let stdout = String::from_utf8_lossy(&o.stdout);
                        let stderr = String::from_utf8_lossy(&o.stderr);
                        if !stdout.is_empty() {
                            print!("{stdout}");
                        }
                        if !stderr.is_empty() {
                            eprint!("{stderr}");
                        }
                    }
                    Err(e) => eprintln!("error: {e}"),
                }
            }
            "quit" | "q" => break,
            "help" | "h" => {
                println!("commands:");
                println!("  read | r           read the braille display");
                println!("  key  | k <key>     press a key (Tab, Down, Return, alt+F1, ...)");
                println!("  type | t <text>    type text");
                println!("  wait | w [ms]      wait then read (default 1000ms)");
                println!("  run  | ! <cmd>     run a shell command");
                println!("  quit | q           exit");
            }
            _ => {
                eprintln!("unknown command: {cmd} (try 'help')");
            }
        }
    }

    Ok(())
}
