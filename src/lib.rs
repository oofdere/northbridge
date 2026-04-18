//! # northbridge
//!
//! A virtual braille display and keyboard for computer use.
//!
//! Northbridge is a deafblind agent's interface to the computer.
//! It connects to BRLTTY as a virtual braille display, receiving
//! screen content as text and sending input back via a virtual keyboard.
//!
//! ## How it works
//!
//! The screen reader (Orca) reads the screen via AT-SPI2 and sends
//! linearized text to BRLTTY. BRLTTY forwards it to northbridge
//! through a pseudo-terminal. Northbridge sends keyboard input to
//! the focused application via xdotool (simulating a regular keyboard).
//!
//! ```text
//! Screen Reader (Orca)
//!   ↓ reads screen via AT-SPI2
//!   ↓ writes text via BrlAPI
//! BRLTTY
//!   ↓ TTY braille driver
//!   ↓ writes to pty
//! Northbridge ← read()
//!   ↓ press_key() / type_text()
//!   ↓ xdotool
//! Focused Application
//! ```
//!
//! ## Usage
//!
//! ```rust,no_run
//! use northbridge::Northbridge;
//!
//! fn main() -> Result<(), northbridge::Error> {
//!     let mut nb = Northbridge::new()?;
//!
//!     // read what's on the braille display
//!     let text = nb.read()?;
//!     println!("{text}");
//!
//!     // send a keystroke to the focused application
//!     nb.press_key("Tab")?;
//!
//!     // read the updated display
//!     let text = nb.read()?;
//!     println!("{text}");
//!
//!     Ok(())
//! }
//! ```

mod display;
mod error;
mod keys;
mod screen;

pub use display::Display;
pub use error::Error;
pub use keys::Key;

use brlapi::Connection;
use std::process::Command;
use std::time::Duration;

/// A virtual braille display and keyboard.
///
/// The display side reads text from Orca via BRLTTY's TTY driver.
/// The keyboard side sends input to the focused application via xdotool.
pub struct Northbridge {
    screen: screen::BrailleScreen,
    connection: Option<Connection>,
    display: Display,
    in_tty_mode: bool,
}

impl Northbridge {
    /// Start northbridge.
    ///
    /// Spawns BRLTTY (with TTY braille driver + AT-SPI2 screen driver)
    /// and Orca (screen reader). Orca reads the screen and sends text
    /// to BRLTTY, which forwards it to northbridge through a pty.
    pub fn new() -> Result<Self, Error> {
        let braille_screen = screen::BrailleScreen::start()?;

        Ok(Self {
            screen: braille_screen,
            connection: None,
            display: Display::new(40, 1),
            in_tty_mode: false,
        })
    }

    /// Start northbridge with a BrlAPI connection for direct display control.
    ///
    /// This connects to a separately-running BRLTTY instance via BrlAPI,
    /// allowing write/read_key operations on the braille display.
    pub fn connect() -> Result<Self, Error> {
        let connection = Connection::open()?;
        let (width, height) = connection.display_size()?;
        let display = Display::new(width, height);

        let result = unsafe {
            brlapi_sys::brlapi__enterTtyModeWithPath(
                connection.handle_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null(),
            )
        };
        let in_tty_mode = result >= 0;

        if !in_tty_mode {
            let result = unsafe {
                brlapi_sys::brlapi__enterTtyMode(
                    connection.handle_ptr(),
                    brlapi_sys::BRLAPI_TTY_DEFAULT,
                    std::ptr::null(),
                )
            };
            if result < 0 {
                return Err(Error::TtyMode);
            }
        }

        let braille_screen = screen::BrailleScreen::start()?;

        Ok(Self {
            screen: braille_screen,
            connection: Some(connection),
            display,
            in_tty_mode: true,
        })
    }

    /// Read the current braille display content as text.
    ///
    /// Returns whatever Orca is currently showing on the braille display —
    /// typically the focused element or current line of the active window.
    pub fn read(&mut self) -> Result<String, Error> {
        self.screen.read()
    }

    /// Send a keystroke to the focused application.
    ///
    /// This simulates pressing a key on the regular keyboard (not the
    /// braille display). The key name follows xdotool syntax:
    /// `"Return"`, `"Tab"`, `"Up"`, `"Down"`, `"space"`, `"a"`, etc.
    /// Modifiers use `+`: `"alt+F4"`, `"ctrl+a"`, `"shift+Tab"`.
    pub fn press_key(&self, key: &str) -> Result<(), Error> {
        let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into());
        Command::new("xdotool")
            .args(["key", "--clearmodifiers", key])
            .env("DISPLAY", &display)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|_| Error::Input)?;
        Ok(())
    }

    /// Type text into the focused application.
    ///
    /// Simulates typing each character on the regular keyboard.
    pub fn type_text(&self, text: &str) -> Result<(), Error> {
        let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into());
        Command::new("xdotool")
            .args(["type", "--clearmodifiers", text])
            .env("DISPLAY", &display)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|_| Error::Input)?;
        Ok(())
    }

    /// Display dimensions in cells (width, height).
    pub fn display_size(&self) -> (u32, u32) {
        (self.display.width, self.display.height)
    }

    /// Write text to the braille display (requires BrlAPI connection via [`connect`]).
    pub fn write(&self, text: &str) -> Result<(), Error> {
        let conn = self.connection.as_ref().ok_or(Error::TtyMode)?;
        let c_text = std::ffi::CString::new(text).map_err(|_| Error::InvalidText)?;

        let result = unsafe {
            brlapi_sys::brlapi__writeText(
                conn.handle_ptr(),
                brlapi_sys::BRLAPI_CURSOR_OFF as i32,
                c_text.as_ptr(),
            )
        };
        if result < 0 {
            return Err(Error::Write);
        }
        Ok(())
    }

    /// Write text with cursor at a specific position (requires BrlAPI connection).
    pub fn write_at(&self, text: &str, cursor: u32) -> Result<(), Error> {
        let conn = self.connection.as_ref().ok_or(Error::TtyMode)?;
        let c_text = std::ffi::CString::new(text).map_err(|_| Error::InvalidText)?;

        let result = unsafe {
            brlapi_sys::brlapi__writeText(
                conn.handle_ptr(),
                cursor as i32,
                c_text.as_ptr(),
            )
        };
        if result < 0 {
            return Err(Error::Write);
        }
        Ok(())
    }

    /// Read a key press from the braille keyboard (requires BrlAPI connection).
    pub fn read_key(&self, timeout: Duration) -> Result<Option<Key>, Error> {
        let conn = self.connection.as_ref().ok_or(Error::TtyMode)?;
        let start = std::time::Instant::now();
        let poll_interval = Duration::from_millis(10);

        loop {
            let mut code: brlapi_sys::brlapi_keyCode_t = 0;
            let result =
                unsafe { brlapi_sys::brlapi__readKey(conn.handle_ptr(), 0, &mut code) };

            match result {
                1 => return Ok(Some(Key::from_code(code))),
                0 => {
                    if start.elapsed() >= timeout {
                        return Ok(None);
                    }
                    std::thread::sleep(poll_interval);
                }
                _ => return Err(Error::ReadKey),
            }
        }
    }

    /// Read a key press, blocking until one arrives (requires BrlAPI connection).
    pub fn read_key_wait(&self) -> Result<Key, Error> {
        let conn = self.connection.as_ref().ok_or(Error::TtyMode)?;
        let mut code: brlapi_sys::brlapi_keyCode_t = 0;

        let result = unsafe {
            brlapi_sys::brlapi__readKey(
                conn.handle_ptr(),
                1,
                &mut code,
            )
        };

        match result {
            1 => Ok(Key::from_code(code)),
            _ => Err(Error::ReadKey),
        }
    }

    /// Get information about the connected braille display.
    pub fn display(&self) -> &Display {
        &self.display
    }
}

impl Drop for Northbridge {
    fn drop(&mut self) {
        if self.in_tty_mode && let Some(ref connection) = self.connection {
            unsafe {
                brlapi_sys::brlapi__leaveTtyMode(connection.handle_ptr());
            }
        }
    }
}
