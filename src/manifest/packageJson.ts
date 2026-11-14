import { DepEntry, Section } from '../types';

const SECTIONS: readonly string[] = ['dependencies', 'devDependencies', 'optionalDependencies'];
const STRING_RE = /"(?:[^"\\]|\\.)*"/g;

export function countBraces(line: string): number {
  const bare = line.replace(STRING_RE, '""');
  let d = 0;
  for (const c of bare) {
    if (c === '{') d++;
    else if (c === '}') d--;
  }
  return d;
}

// ---------------------------------------------------------------------------------------------------------------- tokens

type Kind = '{' | '}' | '[' | ']' | ':' | ',' | 'str' | 'lit';
interface Tok {
  kind: Kind;
  start: number;
  /** offset just past the token */
  end: number;
}

/** Splits JSON text into tokens with offsets. Tolerant: never throws, so a half-typed document still yields what it can. */
function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      const end = text[j] === '"' ? j + 1 : j;
      out.push({ kind: 'str', start: i, end });
      i = end;
    } else if ('{}[]:,'.includes(c)) {
      out.push({ kind: c as Kind, start: i, end: i + 1 });
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      let j = i;
      while (j < text.length && !/[\s{}[\]:,"]/.test(text[j])) j++;
      out.push({ kind: 'lit', start: i, end: Math.max(j, i + 1) });
      i = Math.max(j, i + 1);
    }
  }
  return out;
}

/** Index just past the value that starts at token `i` (a whole object / array when it opens one). */
function skipValue(t: Tok[], i: number): number {
  if (i >= t.length) return i;
  if (t[i].kind !== '{' && t[i].kind !== '[') return i + 1;
  let depth = 0;
  for (; i < t.length; i++) {
    if (t[i].kind === '{' || t[i].kind === '[') depth++;
    else if (t[i].kind === '}' || t[i].kind === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return i;
}

const decode = (text: string, tok: Tok): string => {
  const raw = text.slice(tok.start, tok.end);
  try {
    return JSON.parse(raw);
  } catch {
    return raw.replace(/^"|"$/g, '');
  }
};

interface Member {
  key: string;
  keyTok: Tok;
  /** token index of the value, and the index just past it */
  valIdx: number;
  endIdx: number;
}

/** Members of the object whose `{` is token `open`, and the index of its closing `}` (or the end of the tokens). */
function membersOf(text: string, t: Tok[], open: number): { list: Member[]; close: number } {
  const list: Member[] = [];
  let i = open + 1;
  while (i < t.length && t[i].kind !== '}') {
    if (t[i].kind === 'str' && t[i + 1]?.kind === ':' && i + 2 < t.length) {
      const endIdx = skipValue(t, i + 2);
      list.push({ key: decode(text, t[i]), keyTok: t[i], valIdx: i + 2, endIdx });
      i = endIdx;
    } else {
      i++;
    }
  }
  return { list, close: i };
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ---------------------------------------------------------------------------------------------------------------- locating

/**
 * Locates the dependency entries (line / column) of a package.json so positions stay exact. Works on the tokens, not on lines, so a
 * compact manifest or a one-line section is found too. An entry whose name and version are not on the same line cannot be described
 * by one line and column, and is skipped.
 */
export function locateDeps(text: string): DepEntry[] {
  const t = tokenize(text);
  if (t[0]?.kind !== '{') return [];
  const starts = lineStarts(text);
  const out: DepEntry[] = [];
  for (const top of membersOf(text, t, 0).list) {
    if (!SECTIONS.includes(top.key) || t[top.valIdx]?.kind !== '{') continue;
    for (const m of membersOf(text, t, top.valIdx).list) {
      const val = t[m.valIdx];
      if (val?.kind !== 'str') continue;
      const line = lineOf(starts, m.keyTok.start);
      if (lineOf(starts, val.start) !== line || val.end - val.start < 2 || text[val.end - 1] !== '"') continue;
      const col = (o: number) => o - starts[line];
      out.push({
        name: m.key,
        range: decode(text, val),
        section: top.key as Section,
        line,
        nameStart: col(m.keyTok.start),
        end: col(val.end),
        versionStart: col(val.start) + 1,
        versionEnd: col(val.end) - 1,
      });
    }
  }
  return out;
}

export function detectIndent(text: string): string {
  const m = /^([ \t]+)"/m.exec(text);
  return m ? m[1] : '  ';
}

// ---------------------------------------------------------------------------------------------------------------- editing

function rewrite(text: string, obj: unknown): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let out = JSON.stringify(obj, null, detectIndent(text));
  if (eol === '\r\n') out = out.replace(/\n/g, '\r\n');
  if (/\r?\n$/.test(text)) out += eol;
  return out;
}

/** Whitespace at the start of the line that holds `offset`. */
function indentAt(text: string, starts: number[], offset: number): string {
  const s = starts[lineOf(starts, offset)];
  return /^[ \t]*/.exec(text.slice(s))![0];
}

/** Text for a chain of nested objects ending in `{ name: range }`, indented below `base`. */
function nested(keys: string[], i: number, name: string, range: string, base: string, unit: string, eol: string): string {
  const inner = base + unit;
  if (i === keys.length) return `{${eol}${inner}${JSON.stringify(name)}: ${JSON.stringify(range)}${eol}${base}}`;
  return `{${eol}${inner}${JSON.stringify(keys[i])}: ${nested(keys, i + 1, name, range, inner, unit, eol)}${eol}${base}}`;
}

/** Edits the manifest in place, or returns null when its shape needs the caller to fall back to re-serialising. */
function editInPlace(text: string, keys: string[], name: string, range: string): string | null {
  const t = tokenize(text);
  if (t[0]?.kind !== '{') return null;
  const starts = lineStarts(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const unit = detectIndent(text);
  const value = JSON.stringify(range);

  /** Appends `member` to the object opened at token `open`, matching its layout. */
  const insert = (open: number, member: string): string | null => {
    const { list, close } = membersOf(text, t, open);
    if (close >= t.length) return null;
    if (!list.length) {
      const base = indentAt(text, starts, t[open].start);
      return text.slice(0, t[open].end) + eol + base + unit + member + eol + base + text.slice(t[close].start);
    }
    const last = list[list.length - 1];
    const lastEnd = t[last.endIdx - 1].end;
    const sameLine = lineOf(starts, t[open].start) === lineOf(starts, t[last.endIdx - 1].start);
    const sep = sameLine ? ', ' : `,${eol}${indentAt(text, starts, last.keyTok.start)}`;
    return text.slice(0, lastEnd) + sep + member + text.slice(lastEnd);
  };

  let open = 0;
  for (let k = 0; k < keys.length; k++) {
    const found = membersOf(text, t, open).list.find((m) => m.key === keys[k]);
    if (!found) {
      const base = indentAt(text, starts, t[open].start);
      const { list } = membersOf(text, t, open);
      const memberIndent = list.length ? indentAt(text, starts, list[list.length - 1].keyTok.start) : base + unit;
      return insert(open, `${JSON.stringify(keys[k])}: ${nested(keys, k + 1, name, range, memberIndent, unit, eol)}`);
    }
    if (t[found.valIdx]?.kind !== '{') return null;
    open = found.valIdx;
  }

  const existing = membersOf(text, t, open).list.find((m) => m.key === name);
  if (!existing) return insert(open, `${JSON.stringify(name)}: ${value}`);
  const val = t[existing.valIdx];
  if (val.kind === 'str') return text.slice(0, val.start) + value + text.slice(val.end);
  if (val.kind === '{') {
    // a nested npm override ({ ".": "1.0.0", "child": "2.0.0" }): the package's own version lives under "."
    const own = membersOf(text, t, existing.valIdx).list.find((m) => m.key === '.');
    if (!own) return insert(existing.valIdx, `".": ${value}`);
    const ov = t[own.valIdx];
    return ov.kind === 'str' ? text.slice(0, ov.start) + value + text.slice(ov.end) : null;
  }
  return null;
}

/**
 * Sets `section[name] = range` (section may be a dotted path such as "pnpm.overrides"), touching only the entry: the rest of the
 * file stays byte for byte, and an existing nested npm override keeps its children. Falls back to re-serialising for odd shapes.
 */
export function addToSection(text: string, section: string, name: string, range: string): string {
  const obj = JSON.parse(text); // throws on invalid JSON: nothing is edited in a manifest that cannot be parsed
  const keys = section.split('.');
  const edited = editInPlace(text, keys, name, range);
  if (edited !== null) {
    try {
      JSON.parse(edited);
      return edited;
    } catch {
      /* fall through to the safe path */
    }
  }
  let target = obj;
  for (const k of keys) target = target[k] = target[k] ?? {};
  target[name] = range;
  return rewrite(text, obj);
}
