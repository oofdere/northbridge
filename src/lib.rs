//! # northbridge
//!
//! A virtual braille display and keyboard for computer use.
//!
//! Northbridge is a deafblind agent's interface to the computer.
//! It reads the screen as text and sends input back.
//!
//! ## Usage
//!
//! ```rust,no_run
//! use northbridge::Northbridge;
//!
//! fn main() -> Result<(), northbridge::Error> {
//!     let nb = Northbridge::new();
//!
//!     // read the screen
//!     let screen = nb.read()?;
//!     println!("{screen}");
//!
//!     // send a keystroke
//!     nb.press_key("Return")?;
//!
//!     // click a button by name
//!     nb.click("OK")?;
//!
//!     Ok(())
//! }
//! ```

mod display;
mod error;
mod input;
mod keys;
mod screen;

pub use display::Display;
pub use error::Error;
pub use keys::Key;

use brlapi::Connection;
use std::time::Duration;

/// A virtual braille display and keyboard.
///
/// Reads the screen as text, sends input back.
/// Optionally connects to BRLTTY via BrlAPI for braille display integration.
pub struct Northbridge {
    connection: Option<Connection>,
    display: Display,
    in_tty_mode: bool,
}

impl Default for Northbridge {
    fn default() -> Self {
        Self::new()
    }
}

impl Northbridge {
    /// Create a new northbridge instance.
    ///
    /// Works without BRLTTY — screen reading and input always available.
    /// Call [`connect`] instead if you need braille display integration.
    pub fn new() -> Self {
        Self {
            connection: None,
            display: Display::new(0, 0),
            in_tty_mode: false,
        }
    }

    /// Connect to BRLTTY and take control of the braille display.
    pub fn connect() -> Result<Self, Error> {
        let connection = Connection::open()?;

        let (width, height) = connection.display_size()?;
        let display = Display::new(width, height);

        // Enter TTY mode via raw FFI to avoid self-referential borrow
        let result = unsafe {
            brlapi_sys::brlapi__enterTtyModeWithPath(
                connection.handle_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null(),
            )
        };
        let in_tty_mode = result >= 0;

        // If path-based entry failed, try default TTY
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

        Ok(Self {
            connection: Some(connection),
            display,
            in_tty_mode: true,
        })
    }

    /// Read the current screen content as text.
    pub fn read(&self) -> Result<String, Error> {
        screen::read_screen()
    }

    /// Send a keystroke (e.g. "Return", "ctrl+a", "Tab").
    pub fn press_key(&self, key: &str) -> Result<(), Error> {
        input::press_key(key)
    }

    /// Type text as if on a keyboard.
    pub fn type_text(&self, text: &str) -> Result<(), Error> {
        input::type_text(text)
    }

    /// Click a UI element by name.
    pub fn click(&self, target: &str) -> Result<String, Error> {
        input::click_by_name(target)
    }

    /// Click at screen coordinates.
    pub fn click_at(&self, x: i32, y: i32) -> Result<(), Error> {
        input::click_at(x, y)
    }

    /// Display dimensions in cells (width, height).
    pub fn display_size(&self) -> (u32, u32) {
        (self.display.width, self.display.height)
    }

    /// Write text to the braille display (requires BRLTTY connection).
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

    /// Write text with cursor at a specific position (requires BRLTTY connection).
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

    /// Read a key press from the braille keyboard.
    ///
    /// Polls with non-blocking reads until a key arrives or the timeout expires.
    /// Returns `None` if no key is pressed within the timeout.
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

    /// Read a key press, blocking until one arrives.
    pub fn read_key_wait(&self) -> Result<Key, Error> {
        let conn = self.connection.as_ref().ok_or(Error::TtyMode)?;
        let mut code: brlapi_sys::brlapi_keyCode_t = 0;

        let result = unsafe {
            brlapi_sys::brlapi__readKey(
                conn.handle_ptr(),
                1, // wait
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
