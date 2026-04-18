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

    /// Failed to read screen content.
    #[error("failed to read screen content")]
    ScreenRead,

    /// Failed to send input.
    #[error("failed to send input")]
    Input,

    /// Click target not found.
    #[error("click target not found: {0}")]
    ClickNotFound(String),
}
