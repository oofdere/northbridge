// Key names, Playwright style: "Enter", "Control+Shift+S", "ArrowDown", "a", "F5".
// Lower-case and common aliases ("ctrl+s", "cmd", "esc", "pgdn") are accepted too.

import { NorthbridgeError } from './errors.ts';

export const MODIFIERS = ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'] as const;
export type Modifier = (typeof MODIFIERS)[number];

const NAMED_KEYS = [
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'CapsLock', 'NumLock', 'ScrollLock',
  'PrintScreen', 'Pause', 'ContextMenu', 'Control', 'Shift', 'Alt', 'Meta', 'AltGraph',
  'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute', 'MediaPlayPause', 'MediaTrackNext',
  'MediaTrackPrevious', 'MediaStop',
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
];

const BY_LOWER = new Map(NAMED_KEYS.map((k) => [k.toLowerCase(), k]));

const ALIASES: Record<string, string> = {
  ctrl: 'Control',
  ctl: 'Control',
  control: 'Control',
  shift: 'Shift',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  super: 'Meta',
  win: 'Meta',
  windows: 'Meta',
  altgr: 'AltGraph',
  return: 'Enter',
  enter: 'Enter',
  esc: 'Escape',
  del: 'Delete',
  ins: 'Insert',
  bksp: 'Backspace',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  pgup: 'PageUp',
  pgdn: 'PageDown',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  space: 'Space',
  spacebar: 'Space',
  menu: 'ContextMenu',
  apps: 'ContextMenu',
  prtsc: 'PrintScreen',
  print: 'PrintScreen',
  plus: '+',
  minus: '-',
};

/** Canonical key name for user input, or throws. Single characters pass through unchanged. */
export function normalizeKey(input: string): string {
  if (input === ' ') return 'Space';
  if ([...input].length === 1) return input;
  const lower = input.toLowerCase();
  if (lower === 'controlormeta') return process.platform === 'darwin' ? 'Meta' : 'Control';
  const key = ALIASES[lower] ?? BY_LOWER.get(lower);
  if (!key) throw new NorthbridgeError(`Unknown key "${input}". Use names like Enter, Tab, ArrowDown, F5, or a single character.`);
  return key;
}

export interface KeyCombo {
  modifiers: string[];
  key: string;
}

/** "Control+Shift+s" → { modifiers: ['Control', 'Shift'], key: 's' }. A trailing "+" is the plus key. */
export function parseCombo(combo: string): KeyCombo {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < combo.length; i++) {
    const ch = combo[i];
    if (ch === '+' && current !== '') {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current !== '') parts.push(current);
  if (!parts.length) throw new NorthbridgeError(`Empty key combination "${combo}"`);
  const keys = parts.map((p) => normalizeKey(p.trim() || p));
  const key = keys.pop()!;
  return { modifiers: keys, key };
}

export function isModifier(key: string): key is Modifier {
  return (MODIFIERS as readonly string[]).includes(key);
}
