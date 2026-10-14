export class NorthbridgeError extends Error {
  override name = 'NorthbridgeError';
}

/** A wait ran out of time. The message says what was being waited for and what was found instead. */
export class TimeoutError extends NorthbridgeError {
  override name = 'TimeoutError';
}

/** An action needed exactly one element but the locator matched several. */
export class StrictModeError extends NorthbridgeError {
  override name = 'StrictModeError';
  /** One snapshot line (with ref) per match, so you can pick the one you meant. */
  readonly matches: string[];
  constructor(message: string, matches: string[]) {
    super(message);
    this.matches = matches;
  }
}

/** The element went away (window closed, widget destroyed). */
export class StaleElementError extends NorthbridgeError {
  override name = 'StaleElementError';
}

/** The element or platform can't do what was asked. */
export class NotSupportedError extends NorthbridgeError {
  override name = 'NotSupportedError';
}
