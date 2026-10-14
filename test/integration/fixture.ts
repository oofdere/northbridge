import { fileURLToPath } from 'node:url';
import { type App, connect, type Desktop } from '../../src/index.ts';

/** The Python that has PyGObject (python3-gi) installed. */
export const PYTHON = process.env.NORTHBRIDGE_PYTHON ?? 'python3';
export const GTK3_FIXTURE = fileURLToPath(new URL('../fixtures/gtk3_app.py', import.meta.url));

if (!process.env.NORTHBRIDGE_HEADLESS_DESKTOP && !process.env.NORTHBRIDGE_USE_MY_DESKTOP) {
  throw new Error(
    'Integration tests launch apps and type into them. Run them in a throwaway desktop: ' +
      'npm run test:integration (or set NORTHBRIDGE_USE_MY_DESKTOP=1 if you really mean it).',
  );
}

export async function launchFixture(): Promise<{ desktop: Desktop; app: App }> {
  const desktop = await connect({ timeout: 5000 });
  const app = await desktop.launch([PYTHON, GTK3_FIXTURE]);
  return { desktop, app };
}
