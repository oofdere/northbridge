use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::process::{Child, Command};

use crate::Error;

pub(crate) struct BrailleScreen {
    master: OwnedFd,
    _brltty: Child,
    buf: String,
    last_text: String,
}

fn is_running(name: &str) -> bool {
    Command::new("pgrep")
        .arg(name)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

impl BrailleScreen {
    pub fn start() -> Result<Self, Error> {
        let mut master_fd: libc::c_int = 0;
        let mut slave_fd: libc::c_int = 0;

        let ret = unsafe {
            libc::openpty(
                &mut master_fd,
                &mut slave_fd,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if ret != 0 {
            return Err(Error::ScreenRead);
        }

        let master = unsafe { OwnedFd::from_raw_fd(master_fd) };
        let slave = unsafe { OwnedFd::from_raw_fd(slave_fd) };

        let mut name_buf = [0u8; 256];
        let ret = unsafe {
            libc::ptsname_r(
                master.as_raw_fd(),
                name_buf.as_mut_ptr() as *mut _,
                name_buf.len(),
            )
        };
        if ret != 0 {
            return Err(Error::ScreenRead);
        }
        let slave_path = std::ffi::CStr::from_bytes_until_nul(&name_buf)
            .map_err(|_| Error::ScreenRead)?
            .to_str()
            .map_err(|_| Error::ScreenRead)?
            .to_string();

        drop(slave);

        // Always restart BRLTTY — it needs to be pointed at our new pty
        let _ = Command::new("sudo")
            .args(["pkill", "-9", "brltty"])
            .status();
        std::thread::sleep(std::time::Duration::from_millis(500));
        let _ = std::fs::remove_file("/var/lib/BrlAPI/.0");
        let _ = std::fs::remove_file("/var/lib/BrlAPI/0");

        let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into());
        let dbus = std::env::var("DBUS_SESSION_BUS_ADDRESS")
            .unwrap_or_else(|_| "unix:path=/run/user/1000/bus".into());

        let brltty = Command::new("brltty")
            .args([
                "-b", "tt",
                "-d", &slave_path,
                "-B", "term=xterm",
                "-x", "a2",
                "-n",
                "-e",
            ])
            .env("TERM", "xterm")
            .env("DISPLAY", &display)
            .env("DBUS_SESSION_BUS_ADDRESS", &dbus)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|_| Error::ScreenRead)?;

        // Wait for BRLTTY to create its BrlAPI socket
        std::thread::sleep(std::time::Duration::from_secs(3));

        // Only start Orca if it isn't already running
        if !is_running("orca") {
            let _ = Command::new("orca")
                .args(["--replace", "--disable", "speech"])
                .env("DISPLAY", &display)
                .env("DBUS_SESSION_BUS_ADDRESS", &dbus)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();

            // First launch — wait for Orca to connect to BrlAPI
            std::thread::sleep(std::time::Duration::from_secs(3));
        } else {
            // Orca is already running; give it a moment to reconnect to the new BRLTTY
            std::thread::sleep(std::time::Duration::from_secs(1));
        }

        // Disable echo on the master pty
        unsafe {
            let mut termios: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(master.as_raw_fd(), &mut termios) == 0 {
                termios.c_lflag &= !(libc::ECHO | libc::ECHOE | libc::ECHOK | libc::ECHONL);
                libc::tcsetattr(master.as_raw_fd(), libc::TCSANOW, &termios);
            }
        }

        // Set master fd to non-blocking
        unsafe {
            let flags = libc::fcntl(master.as_raw_fd(), libc::F_GETFL);
            libc::fcntl(
                master.as_raw_fd(),
                libc::F_SETFL,
                flags | libc::O_NONBLOCK,
            );
        }

        let screen = Self {
            master,
            _brltty: brltty,
            buf: String::new(),
            last_text: String::new(),
        };

        Ok(screen)
    }

    /// Read the current display text from BRLTTY.
    ///
    /// Waits briefly for new content if none is immediately available,
    /// since Orca sends display updates asynchronously after focus changes.
    pub fn read(&mut self) -> Result<String, Error> {
        let fd = self.master.as_raw_fd();

        // Poll for data with a timeout — Orca may not have sent anything yet
        for _ in 0..20 {
            let mut raw = vec![0u8; 8192];
            let mut file = unsafe { std::fs::File::from_raw_fd(fd) };

            loop {
                match file.read(&mut raw) {
                    Ok(0) => break,
                    Ok(n) => {
                        self.buf.push_str(&String::from_utf8_lossy(&raw[..n]));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(_) => break,
                }
            }

            // Don't let File drop close our fd
            std::mem::forget(file);

            if !self.buf.is_empty() {
                break;
            }

            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        let text = extract_text(&self.buf);
        self.buf.clear();

        if !text.is_empty() {
            self.last_text = text;
        }

        Ok(self.last_text.clone())
    }
}

impl Drop for BrailleScreen {
    fn drop(&mut self) {
        // Kill BRLTTY (it's bound to our pty), but leave Orca running
        let _ = Command::new("sudo")
            .args(["pkill", "-9", "brltty"])
            .status();
    }
}

fn extract_text(raw: &str) -> String {
    // The TTY braille driver uses curses to render. Each screen update is:
    //   \x1b[H\x1b[2J<text>\r\x1b[2d<braille_dots>\x1b[<cursor>
    //
    // We want the <text> from the LAST complete screen update, since
    // multiple updates may be concatenated in the buffer.

    // Find the last clear-screen sequence: \x1b[H\x1b[2J
    let clear_seq = "\x1b[H\x1b[2J";
    let last_clear = match raw.rfind(clear_seq) {
        Some(pos) => pos + clear_seq.len(),
        None => 0,
    };

    let after_clear = &raw[last_clear..];

    // Text ends at the first \r (before braille line) or \x1b[2d (cursor to row 2)
    let text_end = after_clear
        .find('\r')
        .or_else(|| after_clear.find("\x1b[2d"))
        .unwrap_or(after_clear.len());

    let text_region = &after_clear[..text_end];

    // Strip any remaining escape sequences and control characters
    let ansi_re = regex_lite::Regex::new(
        r"\x1b\[[^a-zA-Z]*[a-zA-Z]|\x1b\[\?[0-9;]*[a-zA-Z]|\x1b[()][0B]|\x1b[=>]|\x0f|\x08",
    )
    .unwrap();
    let clean = ansi_re.replace_all(text_region, "");

    // Strip braille characters, control chars, and curses cursor artifacts
    let text: String = clean
        .chars()
        .filter(|c| {
            !('\u{2800}'..='\u{28FF}').contains(c) && (*c >= ' ' || *c == '\n')
        })
        .collect();

    // Strip trailing curses noise: cursor indicator ({), echo fragments ([B, [A, etc.), $l
    let noise_re =
        regex_lite::Regex::new(r"\s*\{(?:\[.)*(?:\s*\$l)?\s*$|\s*\$l\s*$").unwrap();
    let text = noise_re.replace(&text, "");

    text.trim().to_string()
}
