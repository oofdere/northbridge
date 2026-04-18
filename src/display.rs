/// Information about the connected braille display.
#[derive(Debug, Clone)]
pub struct Display {
    /// Width in braille cells.
    pub width: u32,
    /// Height in braille cells (usually 1).
    pub height: u32,
}

impl Display {
    pub(crate) fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }

    /// Total number of cells on the display.
    pub fn total_cells(&self) -> u32 {
        self.width * self.height
    }
}
