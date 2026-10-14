// What changed between two snapshots. Refs stay attached to the same element across snapshots,
// so a diff by ref says exactly which elements appeared, disappeared or changed.

interface Line {
  ref: string;
  text: string;
  indent: number;
}

function parse(snapshot: string): Line[] {
  const lines: Line[] = [];
  for (const raw of snapshot.split('\n')) {
    const ref = /\[ref=(e\d+)\]/.exec(raw)?.[1];
    if (!ref) continue;
    const indent = raw.length - raw.trimStart().length;
    const text = raw.trim().replace(/^- /, '').replace(/:$/, '').replace(/: …$/, '');
    lines.push({ ref, text, indent });
  }
  return lines;
}

/** Focus moving around is bookkeeping, not news: compare lines without it. */
const withoutFocus = (text: string) => text.replace(/ \[(focused|active)\]/g, '');

export interface ChangeSummary {
  added: number;
  removed: number;
  changed: number;
  /** Human- and model-readable lines: `+ added`, `- removed`, `~ changed (was …)`. */
  text: string;
}

/** Summarize the differences between two snapshots of the same thing. */
export function diffSnapshots(before: string, after: string, maxLines = 60): ChangeSummary {
  const oldLines = parse(before);
  const old = new Map(oldLines.map((l) => [l.ref, l]));
  const now = parse(after);
  const seen = new Set<string>();
  const out: string[] = [];
  let added = 0;
  let changed = 0;
  let blockIndent = -1;
  for (const line of now) {
    seen.add(line.ref);
    const prev = old.get(line.ref);
    if (!prev) {
      added++;
      // Show added subtrees indented relative to their top, so structure shows without deep nesting.
      if (blockIndent < 0 || line.indent < blockIndent) blockIndent = line.indent;
      out.push(`+ ${' '.repeat(line.indent - blockIndent)}${line.text}`);
      continue;
    }
    blockIndent = -1;
    if (withoutFocus(prev.text) !== withoutFocus(line.text)) {
      changed++;
      out.push(`~ ${line.text}  (was: ${prev.text})`);
    }
  }
  // A removed subtree is reported by its top element only.
  let removed = 0;
  let removedIndent = -1;
  for (const line of oldLines) {
    if (seen.has(line.ref)) {
      removedIndent = -1;
      continue;
    }
    removed++;
    if (removedIndent >= 0 && line.indent > removedIndent) continue;
    removedIndent = line.indent;
    out.push(`- ${line.text}`);
  }
  let text = out.slice(0, maxLines).join('\n');
  if (out.length > maxLines) text += `\n… and ${out.length - maxLines} more changes`;
  return { added, removed, changed, text };
}
