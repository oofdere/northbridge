/// Northbridge errors.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// BrlAPI error from the underlying connection.
    #[error("brlapi: {0}")]
    Brlapi(#[from] brlapi::BrlApiError),

    /// Failed to enter TTY mode.
    #[error("failed to enter TTY mode")]
    TtyMode,

    /// Text contained a null byte.
    #[error("text contains null byte")]
    InvalidText,

    /// Failed to write to the display.
    #[error("failed to write to braille display")]
    Write,

    /// Failed to read a key.
    #[error("failed to read key from braille keyboard")]
    ReadKey,
}
