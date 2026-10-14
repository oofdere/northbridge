import type { InputDriver, MouseButton } from './backend.ts';
import { normalizeKey, parseCombo } from './keys.ts';
import type { Point } from './model.ts';
import { sleep } from './util.ts';

/** Synthesized keyboard input, sent to whatever has focus. */
export class Keyboard {
  private readonly driver: () => InputDriver;
  constructor(driver: () => InputDriver) {
    this.driver = driver;
  }

  async down(key: string): Promise<void> {
    await this.driver().keyDown(normalizeKey(key));
  }

  async up(key: string): Promise<void> {
    await this.driver().keyUp(normalizeKey(key));
  }

  /** Press a key or combination: "Enter", "Control+s", "Shift+ArrowDown". */
  async press(combo: string, options: { delay?: number } = {}): Promise<void> {
    const driver = this.driver();
    const { modifiers, key } = parseCombo(combo);
    for (const m of modifiers) await driver.keyDown(m);
    try {
      await driver.keyDown(key);
      if (options.delay) await sleep(options.delay);
      await driver.keyUp(key);
    } finally {
      for (const m of [...modifiers].reverse()) await driver.keyUp(m);
    }
  }

  /** Type text character by character. Anything Unicode works, not just what's on the keyboard. */
  async type(text: string, options: { delay?: number } = {}): Promise<void> {
    await this.driver().typeText(text, options.delay);
  }
}

export interface MouseClickOptions {
  button?: MouseButton;
  clickCount?: number;
  /** Milliseconds between press and release. */
  delay?: number;
}

/** Synthesized mouse input, in screen coordinates. */
export class Mouse {
  private readonly driver: () => InputDriver;
  constructor(driver: () => InputDriver) {
    this.driver = driver;
  }

  async position(): Promise<Point> {
    return this.driver().pointer();
  }

  /** Move to (x, y), optionally in several steps so hover effects and drags see the motion. */
  async move(x: number, y: number, options: { steps?: number } = {}): Promise<void> {
    const driver = this.driver();
    const steps = Math.max(1, options.steps ?? 1);
    if (steps > 1) {
      const from = await driver.pointer();
      for (let i = 1; i < steps; i++) {
        await driver.mouseMove(Math.round(from.x + ((x - from.x) * i) / steps), Math.round(from.y + ((y - from.y) * i) / steps));
      }
    }
    await driver.mouseMove(Math.round(x), Math.round(y));
  }

  async down(options: { button?: MouseButton } = {}): Promise<void> {
    await this.driver().mouseDown(options.button ?? 'left');
  }

  async up(options: { button?: MouseButton } = {}): Promise<void> {
    await this.driver().mouseUp(options.button ?? 'left');
  }

  async click(x: number, y: number, options: MouseClickOptions = {}): Promise<void> {
    const driver = this.driver();
    const button = options.button ?? 'left';
    await this.move(x, y);
    for (let i = 0; i < (options.clickCount ?? 1); i++) {
      await driver.mouseDown(button);
      if (options.delay) await sleep(options.delay);
      await driver.mouseUp(button);
    }
  }

  async dblclick(x: number, y: number, options: Omit<MouseClickOptions, 'clickCount'> = {}): Promise<void> {
    await this.click(x, y, { ...options, clickCount: 2 });
  }

  /** Scroll by wheel steps: positive dy scrolls down, positive dx scrolls right. */
  async wheel(dx: number, dy: number): Promise<void> {
    await this.driver().scroll(dx, dy);
  }

  /** Press at one point, move to another, release. */
  async drag(from: Point, to: Point, options: { steps?: number; button?: MouseButton } = {}): Promise<void> {
    await this.move(from.x, from.y);
    await this.down(options);
    await this.move(to.x, to.y, { steps: options.steps ?? 10 });
    await this.up(options);
  }
}
