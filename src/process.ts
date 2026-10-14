import { readFileSync } from 'node:fs';

/** Parent PID from /proc (Linux). */
export function parentPid(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name is in parentheses and may contain spaces; fields resume after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(fields[1]);
  } catch {
    return undefined;
  }
}

export function isDescendantOf(pid: number, ancestor: number): boolean {
  let current: number | undefined = pid;
  for (let i = 0; current && current > 1 && i < 64; i++) {
    if (current === ancestor) return true;
    current = parentPid(current);
  }
  return false;
}

export function processName(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return undefined;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Split a command line the way a shell would for simple cases: spaces, quotes and backslashes. */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) current += command[++i];
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === '\\' && i + 1 < command.length) {
      current += command[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || current) args.push(current);
      current = '';
      has = false;
    } else {
      current += ch;
    }
  }
  if (has || current) args.push(current);
  return args;
}
