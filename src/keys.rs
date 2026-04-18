/// A key event from the braille keyboard.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Key {
    /// The raw BrlAPI key code.
    pub code: u64,
}

impl Key {
    pub(crate) fn from_code(code: u64) -> Self {
        Self { code }
    }
}
