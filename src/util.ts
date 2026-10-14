export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Collapse whitespace and unify look-alike punctuation so names compare the way people read them. */
export function normalizeText(s: string): string {
  return s
    .replace(/…/g, '...')
    .replace(/[   ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

/** Poll intervals for auto-waiting: quick at first, then backing off. */
export function* pollIntervals(): Generator<number> {
  yield 0;
  yield 50;
  yield 100;
  yield 100;
  yield 250;
  for (;;) yield 500;
}

export function isRegExp(v: unknown): v is RegExp {
  return v instanceof RegExp;
}

/** Damerau-free edit distance, good enough to suggest "did you mean" candidates. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
