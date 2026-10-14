// Selector strings. They read like snapshot lines, so you can point at what you see:
//
//   button "Save"                  role + accessible name (whole name, case-insensitive)
//   "Save"                         any role with that name
//   button /save/i                 name by regex
//   textbox "Email" [focused]      with a state; [checked=false] negates
//   dialog "Open File" >> button "Open"   inside (a space works too); `>` for direct children
//   #save-button                   by accessible id (AccessibleId / AXIdentifier / AutomationId)
//   @e12  or  e12                  by ref from a snapshot
//   listitem:has-text("Inbox")     has(…), has-text(…), text(…), nth(…), first, last, visible, hidden
//   - checkbox "Remember me" [checked] [ref=e7]   ← a pasted snapshot line works too

import { NorthbridgeError } from './errors.ts';
import { normalizeRole, type Role, STATES } from './model.ts';
import type { FilterStep, MatchStep, Query, StateFilter, Step, TextMatcher } from './query.ts';
import { RefRegistry } from './refs.ts';

export class SelectorError extends NorthbridgeError {
  override name = 'SelectorError';
}

const STATE_NAMES = new Set<string>([...STATES, 'disabled', 'visible', 'hidden', 'unchecked']);
const IDENT = /[A-Za-z0-9_-]/;

class Parser {
  private pos = 0;
  private readonly s: string;
  constructor(input: string) {
    this.s = input;
  }

  private fail(message: string): never {
    throw new SelectorError(`${message} at position ${this.pos} in selector ${JSON.stringify(this.s)}`);
  }
  private peek(offset = 0): string {
    return this.s[this.pos + offset] ?? '';
  }
  private skipWs(): boolean {
    const start = this.pos;
    while (/\s/.test(this.peek())) this.pos++;
    return this.pos > start;
  }
  private atEnd(): boolean {
    return this.pos >= this.s.length;
  }
  private expect(ch: string): void {
    if (this.peek() !== ch) this.fail(`Expected "${ch}"`);
    this.pos++;
  }

  parse(): Query {
    this.skipWs();
    // Tolerate pasted snapshot lines: "- button "Save" [ref=e3]"
    if (this.peek() === '-' && /\s/.test(this.peek(1))) {
      this.pos++;
      this.skipWs();
    }
    const query = this.parseAlternatives('');
    this.skipWs();
    if (!this.atEnd()) this.fail(`Unexpected "${this.peek()}"`);
    return query;
  }

  private parseAlternatives(closer: string): Query {
    const alternatives = [this.parseChain(closer)];
    while (this.peek() === ',') {
      this.pos++;
      alternatives.push(this.parseChain(closer));
    }
    return alternatives.length === 1 ? alternatives[0] : { steps: [{ type: 'union', queries: alternatives }] };
  }

  private parseChain(closer: string): Query {
    const steps: Step[] = [];
    let combinator: 'descendant' | 'child' = 'descendant';
    let first = true;
    for (;;) {
      this.skipWs();
      if (this.atEnd() || this.peek() === ',' || (closer && this.peek() === closer)) break;
      if (this.peek() === ':' && (/\s/.test(this.peek(1)) || this.peek(1) === '')) {
        // the ": value" tail of a pasted snapshot line
        this.pos = this.s.length;
        break;
      }
      if (!first) {
        if (this.s.startsWith('>>', this.pos)) {
          this.pos += 2;
          this.skipWs();
        } else if (this.peek() === '>') {
          this.pos++;
          this.skipWs();
          combinator = 'child';
        }
      }
      steps.push(...this.parseCompound(combinator));
      combinator = 'descendant';
      first = false;
    }
    if (!steps.length) this.fail('Empty selector');
    return { steps };
  }

  private parseCompound(combinator: 'descendant' | 'child'): Step[] {
    const match: MatchStep = { type: 'match' };
    if (combinator === 'child') match.combinator = 'child';
    const extra: Step[] = [];
    let ref: string | undefined;
    const c = this.peek();

    if (c === '@') {
      this.pos++;
      ref = this.parseIdent();
    } else if (c === '#') {
      this.pos++;
      const start = this.pos;
      while (!this.atEnd() && !/[\s\[\]:>,"'()]/.test(this.peek())) this.pos++;
      if (start === this.pos) this.fail('Expected an id after "#"');
      match.id = { kind: 'exact', value: this.s.slice(start, this.pos), caseSensitive: true };
    } else if (c === '*') {
      this.pos++;
    } else if (c === '"' || c === "'" || c === '/') {
      match.name = this.parseText();
    } else if (IDENT.test(c)) {
      const word = this.parseIdent();
      if (/^e\d+$/.test(word)) ref = word;
      else {
        const role = normalizeRole(word);
        if (!role) this.fail(`Unknown role "${word}"`);
        match.roles = [role];
      }
    } else if (c !== '[' && c !== ':') {
      this.fail(`Unexpected "${c}"`);
    }

    // Name may follow the role after whitespace: button "Save"
    const save = this.pos;
    this.skipWs();
    if (!ref && !match.name && (this.peek() === '"' || this.peek() === "'" || (this.peek() === '/' && match.roles))) {
      match.name = this.parseText();
    } else {
      this.pos = save;
    }

    // Attributes and pseudo-classes, which may also follow after whitespace (snapshot style).
    for (;;) {
      const before = this.pos;
      this.skipWs();
      if (this.peek() === '[') {
        const refFromAttr = this.parseAttribute(match);
        if (refFromAttr) ref = refFromAttr;
      } else if (this.peek() === ':' && /[a-z]/i.test(this.peek(1))) {
        this.parsePseudo(match, extra);
      } else {
        this.pos = before;
        break;
      }
    }

    if (ref) return [{ type: 'ref', ref: RefRegistry.normalize(ref) }, ...extra];
    return [match, ...extra];
  }

  private parseIdent(): string {
    const start = this.pos;
    while (IDENT.test(this.peek())) this.pos++;
    if (start === this.pos) this.fail('Expected a name');
    return this.s.slice(start, this.pos);
  }

  private parseString(): { value: string; caseSensitive?: boolean } {
    const quote = this.peek();
    const start = this.pos;
    this.pos++;
    while (!this.atEnd() && this.peek() !== quote) {
      if (this.peek() === '\\') this.pos++;
      this.pos++;
    }
    if (this.atEnd()) this.fail('Unterminated string');
    this.pos++;
    const raw = this.s.slice(start + 1, this.pos - 1);
    let value: string;
    try {
      value = JSON.parse(`"${quote === "'" ? raw.replace(/\\'/g, "'").replace(/"/g, '\\"') : raw}"`);
    } catch {
      value = raw;
    }
    let caseSensitive: boolean | undefined;
    if ((this.peek() === 's' || this.peek() === 'i') && !IDENT.test(this.peek(1))) {
      caseSensitive = this.peek() === 's';
      this.pos++;
    }
    return { value, caseSensitive };
  }

  private parseRegex(): RegExp {
    this.expect('/');
    const start = this.pos;
    let inClass = false;
    while (!this.atEnd()) {
      const ch = this.peek();
      if (ch === '\\') this.pos++;
      else if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) break;
      this.pos++;
    }
    if (this.atEnd()) this.fail('Unterminated regular expression');
    const source = this.s.slice(start, this.pos);
    this.pos++;
    const flagsStart = this.pos;
    while (/[imsuy]/.test(this.peek())) this.pos++;
    try {
      return new RegExp(source, this.s.slice(flagsStart, this.pos));
    } catch (err) {
      this.fail((err as Error).message);
    }
  }

  /** "Save" → exact (case-insensitive); "Save"s → exact, case-sensitive; /save/i → regex. */
  private parseText(kind: 'exact' | 'contains' = 'exact'): TextMatcher {
    if (this.peek() === '/') return { kind: 'regex', value: this.parseRegex() };
    if (this.peek() !== '"' && this.peek() !== "'") this.fail('Expected a quoted string or /regex/');
    const { value, caseSensitive } = this.parseString();
    return { kind, value, caseSensitive };
  }

  private parseValue(op: string): TextMatcher {
    this.skipWs();
    if (op === '~=' || this.peek() === '/') return { kind: 'regex', value: this.peek() === '/' ? this.parseRegex() : new RegExp(this.parseString().value) };
    let value: string;
    let caseSensitive: boolean | undefined;
    if (this.peek() === '"' || this.peek() === "'") ({ value, caseSensitive } = this.parseString());
    else {
      const start = this.pos;
      while (!this.atEnd() && this.peek() !== ']') this.pos++;
      value = this.s.slice(start, this.pos).trim();
    }
    const esc = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flags = caseSensitive ? '' : 'i';
    switch (op) {
      case '*=':
        return { kind: 'contains', value, caseSensitive };
      case '^=':
        return { kind: 'regex', value: new RegExp(`^\\s*${esc}`, flags) };
      case '$=':
        return { kind: 'regex', value: new RegExp(`${esc}\\s*$`, flags) };
      default:
        return { kind: 'exact', value, caseSensitive };
    }
  }

  /** Returns a ref if the attribute was [ref=…]. */
  private parseAttribute(match: MatchStep): string | undefined {
    this.expect('[');
    this.skipWs();
    const key = this.parseIdent().toLowerCase();
    this.skipWs();
    let op = '';
    for (const candidate of ['*=', '^=', '$=', '~=', '!=', '=']) {
      if (this.s.startsWith(candidate, this.pos)) {
        op = candidate;
        this.pos += candidate.length;
        break;
      }
    }
    let result: string | undefined;
    if (!op) {
      this.setState(match, key, true);
    } else if (STATE_NAMES.has(key)) {
      this.skipWs();
      const word = this.parseIdent().toLowerCase();
      if (word !== 'true' && word !== 'false') this.fail(`State [${key}] takes true or false`);
      this.setState(match, key, (word === 'true') !== (op === '!='));
    } else {
      const value = this.parseValue(op);
      switch (key) {
        case 'name':
          match.name = value;
          break;
        case 'text':
          match.text = value;
          break;
        case 'label':
          match.label = value;
          break;
        case 'desc':
        case 'description':
          match.description = value;
          break;
        case 'id':
          match.id = value.kind === 'exact' ? { ...value, caseSensitive: true } : value;
          break;
        case 'native':
        case 'nativerole':
          match.nativeRole = value;
          break;
        case 'role': {
          const role = value.kind !== 'regex' ? normalizeRole(value.value) : undefined;
          if (!role) this.fail('Unknown role');
          match.roles = [role as Role];
          break;
        }
        case 'ref':
          if (value.kind === 'regex') this.fail('[ref] takes a plain value');
          result = value.value;
          break;
        default:
          this.fail(`Unknown attribute "${key}"`);
      }
    }
    this.skipWs();
    this.expect(']');
    return result;
  }

  private setState(match: MatchStep, key: string, want: boolean): void {
    if (!STATE_NAMES.has(key)) this.fail(`Unknown state "${key}"`);
    match.states ??= {};
    if (key === 'unchecked') match.states.checked = !want;
    else match.states[key as StateFilter] = want;
    if (key === 'hidden' && want) match.includeHidden = true;
  }

  private parsePseudo(match: MatchStep, extra: Step[]): void {
    this.expect(':');
    const name = this.parseIdent().toLowerCase();
    const arg = <T>(fn: () => T): T => {
      this.skipWs();
      this.expect('(');
      this.skipWs();
      const value = fn();
      this.skipWs();
      this.expect(')');
      return value;
    };
    switch (name) {
      case 'first':
        extra.push({ type: 'nth', index: 0 });
        return;
      case 'last':
        extra.push({ type: 'nth', index: -1 });
        return;
      case 'nth': {
        const n = arg(() => {
          const start = this.pos;
          if (this.peek() === '-') this.pos++;
          while (/\d/.test(this.peek())) this.pos++;
          const v = Number(this.s.slice(start, this.pos));
          if (!Number.isInteger(v) || start === this.pos) this.fail('Expected an index');
          return v;
        });
        extra.push({ type: 'nth', index: n });
        return;
      }
      case 'has':
        extra.push({ type: 'filter', has: arg(() => this.parseAlternatives(')')) });
        return;
      case 'has-text':
        extra.push({ type: 'filter', hasText: arg(() => this.parseText('contains')) });
        return;
      case 'text':
        match.text = arg(() => this.parseText('contains'));
        return;
      case 'text-is':
        match.text = arg(() => this.parseText('exact'));
        return;
      case 'visible':
        extra.push({ type: 'filter', visible: true });
        return;
      case 'hidden':
        match.includeHidden = true;
        extra.push({ type: 'filter', visible: false });
        return;
      case 'any-visibility':
        match.includeHidden = true;
        return;
      case 'not': {
        const inner: Step[] = [];
        arg(() => this.parsePseudo(match, inner));
        for (const step of inner) {
          if (step.type !== 'filter') this.fail(':not() supports :has() and :has-text()');
          const negated: FilterStep = { type: 'filter' };
          if (step.has) negated.hasNot = step.has;
          if (step.hasText) negated.hasNotText = step.hasText;
          if (step.visible !== undefined) negated.visible = !step.visible;
          extra.push(negated);
        }
        return;
      }
      default:
        this.fail(`Unknown pseudo-class ":${name}"`);
    }
  }
}

export function parseSelector(selector: string): Query {
  return new Parser(selector).parse();
}
