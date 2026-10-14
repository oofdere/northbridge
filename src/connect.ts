import { AtspiBackend } from './atspi/backend.ts';
import type { Backend } from './backend.ts';
import { Desktop } from './desktop.ts';
import { NotSupportedError } from './errors.ts';
import type { RefRegistry } from './refs.ts';

export interface ConnectOptions {
  /** Default timeout in ms for auto-waiting actions and assertions. Default 5000. */
  timeout?: number;
  /** Flip the desktop's accessibility switch on so every toolkit exposes its tree. Default true. */
  enableAccessibility?: boolean;
  /** Set up keyboard/mouse synthesis and screenshots where the display allows it. Default true. */
  input?: boolean;
  /** Use a specific backend instead of the platform's own. */
  backend?: Backend;
  /** Reuse refs from an earlier session (the CLI does this). */
  refs?: RefRegistry;
}

/** Connect to the desktop's accessibility tree. */
export async function connect(options: ConnectOptions = {}): Promise<Desktop> {
  const backend = options.backend ?? (await platformBackend(options));
  return new Desktop(backend, { refs: options.refs, timeout: options.timeout });
}

async function platformBackend(options: ConnectOptions): Promise<Backend> {
  switch (process.platform) {
    case 'linux':
    case 'freebsd':
    case 'openbsd':
    case 'netbsd': {
      const backend = await AtspiBackend.connect({ enableAccessibility: options.enableAccessibility });
      if (options.input !== false) {
        const { attachX11 } = await import('./x11/attach.ts');
        await attachX11(backend);
      }
      return backend;
    }
    default:
      throw new NotSupportedError(
        `northbridge doesn't support ${process.platform} yet. Linux (AT-SPI) works today; ` +
          'macOS (AX) and Windows (UI Automation) backends implement the same Backend interface.',
      );
  }
}
