/**
 * Short, stable names for elements ("e12"). The same element keeps its ref across snapshots,
 * so an agent can act on what it saw a moment ago without re-reading the tree.
 */
export class RefRegistry {
  private readonly keyToRef = new Map<string, string>();
  private readonly refToKey = new Map<string, string>();
  private counter = 0;

  refFor(key: string): string {
    let ref = this.keyToRef.get(key);
    if (!ref) {
      ref = `e${++this.counter}`;
      this.keyToRef.set(key, ref);
      this.refToKey.set(ref, key);
    }
    return ref;
  }

  /** Accepts "e12", "@e12" or "[ref=e12]". */
  keyFor(ref: string): string | undefined {
    return this.refToKey.get(RefRegistry.normalize(ref));
  }

  static normalize(ref: string): string {
    return ref.trim().replace(/^\[?(ref=)?@?/, '').replace(/\]$/, '');
  }

  static isRef(s: string): boolean {
    return /^(@|\[ref=)?e\d+\]?$/.test(s.trim());
  }

  /** Take over refs from another registry (e.g. one saved by an earlier process). */
  merge(other: RefRegistry): void {
    const data = other.toJSON();
    this.counter = Math.max(this.counter, data.counter);
    for (const [ref, key] of Object.entries(data.refs)) {
      if (this.keyToRef.has(key) || this.refToKey.has(ref)) continue;
      this.refToKey.set(ref, key);
      this.keyToRef.set(key, ref);
    }
  }

  forget(predicate: (key: string) => boolean): void {
    for (const [key, ref] of this.keyToRef) {
      if (predicate(key)) {
        this.keyToRef.delete(key);
        this.refToKey.delete(ref);
      }
    }
  }

  get size(): number {
    return this.keyToRef.size;
  }

  toJSON(): { counter: number; refs: Record<string, string> } {
    return { counter: this.counter, refs: Object.fromEntries(this.refToKey) };
  }

  static fromJSON(data: { counter?: number; refs?: Record<string, string> } | undefined): RefRegistry {
    const registry = new RefRegistry();
    if (!data) return registry;
    registry.counter = data.counter ?? 0;
    for (const [ref, key] of Object.entries(data.refs ?? {})) {
      registry.refToKey.set(ref, key);
      registry.keyToRef.set(key, ref);
    }
    return registry;
  }
}
