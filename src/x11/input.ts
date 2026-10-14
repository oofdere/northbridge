// Keyboard and mouse synthesis through the XTEST extension.

import type { InputDriver, MouseButton } from '../backend.ts';
import { NotSupportedError } from '../errors.ts';
import type { Point } from '../model.ts';
import { sleep } from '../util.ts';
import type { X11Connection } from './connection.ts';
import { caseVariants, charKeysym, FALLBACKS, keysymFor } from './keysyms.ts';

const KEY_PRESS = 2;
const KEY_RELEASE = 3;
const BUTTON_PRESS = 4;
const BUTTON_RELEASE = 5;
const MOTION = 6;

const BUTTONS: Record<MouseButton, number> = { left: 1, middle: 2, right: 3 };
const SHIFT = 0xffe1;
const LEVEL3 = 0xfe03;

interface KeyStroke {
  keycode: number;
  /** Modifier keycodes to hold while pressing. */
  modifiers: number[];
}

export class X11Input implements InputDriver {
  private readonly x: X11Connection;
  private readonly major: number;
  private perKeycode = 0;
  private keysyms: number[][] = [];
  /** Spare keycodes we've borrowed for characters the keyboard doesn't have. */
  private readonly borrowed = new Map<number, number>(); // keysym → keycode
  private spare: number[] = [];
  private nextSpare = 0;
  /** Keys held down via keyDown, so keyUp releases exactly what was pressed. */
  private readonly held = new Map<string, KeyStroke>();

  private constructor(x: X11Connection, major: number) {
    this.x = x;
    this.major = major;
  }

  static async create(x: X11Connection, major: number): Promise<X11Input> {
    const input = new X11Input(x, major);
    await input.loadKeymap();
    return input;
  }

  private async loadKeymap(): Promise<void> {
    const { perKeycode, keysyms } = await this.x.getKeyboardMapping();
    this.perKeycode = perKeycode;
    this.keysyms = keysyms;
    // Keycodes with nothing on them can be borrowed; take them from the top, away from real keys.
    this.spare = keysyms
      .map((row, i) => (row.every((k) => k === 0) ? i + this.x.setup.minKeycode : -1))
      .filter((k) => k > 0)
      .reverse()
      .slice(0, 8);
  }

  private keycodeOf(keysym: number): { keycode: number; level: number } | null {
    let best: { keycode: number; level: number } | null = null;
    for (let i = 0; i < this.keysyms.length; i++) {
      const row = this.keysyms[i];
      for (let level = 0; level < row.length; level++) {
        if (row[level] !== keysym) continue;
        // Levels 0/1 are plain and shifted; 4/5 need AltGr. Group 2 (2/3) we can't select.
        if (level === 2 || level === 3) continue;
        if (!best || level < best.level) best = { keycode: i + this.x.setup.minKeycode, level };
      }
    }
    return best;
  }

  private modifierKeycode(keysym: number): number | null {
    const found = this.keycodeOf(keysym);
    if (found) return found.keycode;
    for (const alt of FALLBACKS[keysym] ?? []) {
      const f = this.keycodeOf(alt);
      if (f) return f.keycode;
    }
    return null;
  }

  private async stroke(keysym: number): Promise<KeyStroke> {
    let found = this.keycodeOf(keysym);
    // Keymaps often only list the lower-case letter; Shift gives the upper case.
    const variants = caseVariants(keysym);
    if (!found && variants && keysym === variants.upper) {
      const lower = this.keycodeOf(variants.lower);
      if (lower && lower.level === 0) found = { keycode: lower.keycode, level: 1 };
    }
    if (!found && FALLBACKS[keysym]) {
      for (const alt of FALLBACKS[keysym]) {
        found = this.keycodeOf(alt);
        if (found) break;
      }
    }
    if (found) {
      const modifiers: number[] = [];
      if (found.level === 1 || found.level === 5) {
        const shift = this.modifierKeycode(SHIFT);
        if (shift) modifiers.push(shift);
      }
      if (found.level === 4 || found.level === 5) {
        const level3 = this.modifierKeycode(LEVEL3);
        if (!level3) return this.borrow(keysym);
        modifiers.push(level3);
      }
      return { keycode: found.keycode, modifiers };
    }
    return this.borrow(keysym);
  }

  /** Map a spare keycode to a keysym the keyboard doesn't have (any Unicode character). */
  private async borrow(keysym: number): Promise<KeyStroke> {
    const existing = this.borrowed.get(keysym);
    if (existing) return { keycode: existing, modifiers: [] };
    if (!this.spare.length) throw new NotSupportedError(`Can't type keysym 0x${keysym.toString(16)}: no spare keycodes`);
    const keycode = this.spare[this.nextSpare++ % this.spare.length];
    for (const [sym, code] of this.borrowed) if (code === keycode) this.borrowed.delete(sym);
    const row = new Array(this.perKeycode).fill(keysym);
    this.x.changeKeyboardMapping(keycode, this.perKeycode, [row]);
    this.keysyms[keycode - this.x.setup.minKeycode] = row;
    this.borrowed.set(keysym, keycode);
    await this.x.sync();
    // Give clients a moment to pick up the MappingNotify before the key arrives.
    await sleep(30);
    return { keycode, modifiers: [] };
  }

  /** Put borrowed keycodes back the way we found them. */
  async restoreKeymap(): Promise<void> {
    for (const keycode of this.borrowed.values()) {
      this.x.changeKeyboardMapping(keycode, this.perKeycode, [new Array(this.perKeycode).fill(0)]);
    }
    this.borrowed.clear();
    await this.x.sync().catch(() => {});
  }

  private send(type: number, detail: number, x = 0, y = 0): void {
    this.x.fakeInput(this.major, type, detail, x, y);
  }

  async keyDown(key: string): Promise<void> {
    if (this.held.has(key)) return;
    const stroke = await this.stroke(keysymFor(key));
    for (const m of stroke.modifiers) this.send(KEY_PRESS, m);
    this.send(KEY_PRESS, stroke.keycode);
    this.held.set(key, stroke);
    await this.x.sync();
  }

  async keyUp(key: string): Promise<void> {
    const stroke = this.held.get(key) ?? (await this.stroke(keysymFor(key)));
    this.held.delete(key);
    this.send(KEY_RELEASE, stroke.keycode);
    for (const m of [...stroke.modifiers].reverse()) this.send(KEY_RELEASE, m);
    await this.x.sync();
  }

  async typeText(text: string, delay = 0): Promise<void> {
    for (const ch of text) {
      if (ch === '\r') continue;
      const stroke = await this.stroke(charKeysym(ch));
      for (const m of stroke.modifiers) this.send(KEY_PRESS, m);
      this.send(KEY_PRESS, stroke.keycode);
      this.send(KEY_RELEASE, stroke.keycode);
      for (const m of [...stroke.modifiers].reverse()) this.send(KEY_RELEASE, m);
      if (delay) {
        await this.x.sync();
        await sleep(delay);
      }
    }
    await this.x.sync();
  }

  async mouseMove(x: number, y: number): Promise<void> {
    this.send(MOTION, 0, x, y);
    await this.x.sync();
  }

  async mouseDown(button: MouseButton): Promise<void> {
    this.send(BUTTON_PRESS, BUTTONS[button]);
    await this.x.sync();
  }

  async mouseUp(button: MouseButton): Promise<void> {
    this.send(BUTTON_RELEASE, BUTTONS[button]);
    await this.x.sync();
  }

  async scroll(dx: number, dy: number): Promise<void> {
    const steps = (count: number, button: number) => {
      for (let i = 0; i < Math.abs(Math.round(count)); i++) {
        this.send(BUTTON_PRESS, button);
        this.send(BUTTON_RELEASE, button);
      }
    };
    steps(dy, dy > 0 ? 5 : 4);
    steps(dx, dx > 0 ? 7 : 6);
    await this.x.sync();
  }

  pointer(): Promise<Point> {
    return this.x.queryPointer();
  }
}
