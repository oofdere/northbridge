// X11 keysyms for northbridge key names and for arbitrary characters.

const NAMED: Record<string, number> = {
  Enter: 0xff0d,
  Tab: 0xff09,
  Escape: 0xff1b,
  Backspace: 0xff08,
  Delete: 0xffff,
  Insert: 0xff63,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  Space: 0x20,
  CapsLock: 0xffe5,
  NumLock: 0xff7f,
  ScrollLock: 0xff14,
  PrintScreen: 0xff61,
  Pause: 0xff13,
  ContextMenu: 0xff67,
  Control: 0xffe3,
  Shift: 0xffe1,
  Alt: 0xffe9,
  Meta: 0xffeb, // Super_L
  AltGraph: 0xfe03, // ISO_Level3_Shift
  AudioVolumeUp: 0x1008ff13,
  AudioVolumeDown: 0x1008ff11,
  AudioVolumeMute: 0x1008ff12,
  MediaPlayPause: 0x1008ff14,
  MediaStop: 0x1008ff15,
  MediaTrackPrevious: 0x1008ff16,
  MediaTrackNext: 0x1008ff17,
};
for (let i = 1; i <= 24; i++) NAMED[`F${i}`] = 0xffbe + i - 1;

/** Alternative keysyms to try when the preferred one isn't on the keyboard. */
export const FALLBACKS: Record<number, number[]> = {
  0xffeb: [0xffe7, 0xffec], // Super_L → Meta_L, Super_R
  0xffe9: [0xffea, 0xffe7], // Alt_L → Alt_R, Meta_L
  0xffe3: [0xffe4], // Control_L → Control_R
  0xffe1: [0xffe2], // Shift_L → Shift_R
  0xfe03: [0xff7e], // ISO_Level3_Shift → Mode_switch
};

/** The keysym for a character: Latin-1 maps directly, everything else via the Unicode range. */
export function charKeysym(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (ch === '\n' || ch === '\r') return 0xff0d;
  if (ch === '\t') return 0xff09;
  if (ch === '\b') return 0xff08;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return 0x01000000 + cp;
}

export function keysymFor(key: string): number {
  return NAMED[key] ?? charKeysym(key);
}

/** For letters: the other-case keysym, since keymaps often list only one case. */
export function caseVariants(keysym: number): { lower: number; upper: number } | null {
  if (keysym >= 0x41 && keysym <= 0x5a) return { lower: keysym + 0x20, upper: keysym };
  if (keysym >= 0x61 && keysym <= 0x7a) return { lower: keysym, upper: keysym - 0x20 };
  if (keysym >= 0xc0 && keysym <= 0xde && keysym !== 0xd7) return { lower: keysym + 0x20, upper: keysym };
  if (keysym >= 0xe0 && keysym <= 0xfe && keysym !== 0xf7) return { lower: keysym, upper: keysym - 0x20 };
  return null;
}
