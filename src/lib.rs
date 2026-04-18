//! # northbridge
//!
//! A virtual braille display and keyboard for computer use.
//!
//! Northbridge connects to BRLTTY via BrlAPI, giving you a text interface
//! to the braille display. Write text to the display, read key presses
//! from the braille keyboard.
//!
//! ## Usage
//!
//! ```rust,no_run
//! use northbridge::Northbridge;
//! use std::time::Duration;
//!
//! fn main() -> Result<(), northbridge::Error> {
//!     let nb = Northbridge::connect()?;
//!
//!     // display info
//!     let (w, h) = nb.display_size();
//!     println!("{w}x{h} cells");
//!
//!     // write text to the display
//!     nb.write("hello from northbridge")?;
//!
//!     // read a key press (blocks up to 1s)
//!     if let Some(key) = nb.read_key(Duration::from_secs(1))? {
//!         println!("got key: {key:?}");
//!     }
//!
//!     Ok(())
//! }
//! ```

mod display;
mod error;
mod keys;

pub use display::Display;
pub use error::Error;
pub use keys::Key;

use brlapi::Connection;
use std::time::Duration;

/// A virtual braille display and keyboard.
///
/// Connects to BRLTTY via BrlAPI, enters TTY mode, and provides
/// a text-based interface to the braille display and keyboard.
pub struct Northbridge {
    connection: Connection,
    display: Display,
    in_tty_mode: bool,
}

impl Northbridge {
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
            connection,
            display,
            in_tty_mode: true,
        })
    }

    /// Display dimensions in cells (width, height).
    pub fn display_size(&self) -> (u32, u32) {
        (self.display.width, self.display.height)
    }

    /// Write text to the braille display.
    ///
    /// Text is truncated to fit the display width.
    pub fn write(&self, text: &str) -> Result<(), Error> {
        let c_text = std::ffi::CString::new(text).map_err(|_| Error::InvalidText)?;

        let result = unsafe {
            brlapi_sys::brlapi__writeText(
                self.connection.handle_ptr(),
                brlapi_sys::BRLAPI_CURSOR_OFF as i32,
                c_text.as_ptr(),
            )
        };
        if result < 0 {
            return Err(Error::Write);
        }
        Ok(())
    }

    /// Write text with cursor at a specific position (0-based).
    pub fn write_at(&self, text: &str, cursor: u32) -> Result<(), Error> {
        let c_text = std::ffi::CString::new(text).map_err(|_| Error::InvalidText)?;

        let result = unsafe {
            brlapi_sys::brlapi__writeText(
                self.connection.handle_ptr(),
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
        let start = std::time::Instant::now();
        let poll_interval = Duration::from_millis(10);

        loop {
            let mut code: brlapi_sys::brlapi_keyCode_t = 0;

            let result =
                unsafe { brlapi_sys::brlapi__readKey(self.connection.handle_ptr(), 0, &mut code) };

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
        let mut code: brlapi_sys::brlapi_keyCode_t = 0;

        let result = unsafe {
            brlapi_sys::brlapi__readKey(
                self.connection.handle_ptr(),
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
        if self.in_tty_mode {
            unsafe {
                brlapi_sys::brlapi__leaveTtyMode(self.connection.handle_ptr());
            }
        }
    }
}
