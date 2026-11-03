import { compare, parse } from './semver';

type Op = '>=' | '>' | '<' | '<=' | '=';
interface Cmp {
  op: Op;
  v: string;
}

const PARTIAL = /^v?(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/;

interface Partial {
  major?: number;
  minor?: number;
  patch?: number;
  pre: string;
}

function partial(s: string): Partial | null {
  const m = PARTIAL.exec(s);
  if (!m) return null;
  const n = (x?: string) => (x === undefined || /^[xX*]$/.test(x) ? undefined : +x);
  const major = n(m[1]);
  const minor = major === undefined ? undefined : n(m[2]);
  const patch = minor === undefined ? undefined : n(m[3]);
  return { major, minor, patch, pre: m[4] ?? '' };
}

const v3 = (a: number, b: number, c: number, pre = '') => `${a}.${b}.${c}${pre ? '-' + pre : ''}`;

/** Lowest version covered by a partial ("1.2" -> 1.2.0) */
function floor(p: Partial): string {
  return v3(p.major ?? 0, p.minor ?? 0, p.patch ?? 0, p.pre);
}

/** Exclusive upper bound of the x-range a partial stands for ("1.2" -> 1.3.0), or null when unbounded ("*"). */
function ceil(p: Partial): string | null {
  if (p.major === undefined) return null;
  if (p.minor === undefined) return v3(p.major + 1, 0, 0);
  if (p.patch === undefined) return v3(p.major, p.minor + 1, 0);
  return null;
}

function expand(token: string): Cmp[] | null {
  const m = /^(\^|~>?|>=|<=|>|<|=)?\s*(.*)$/.exec(token)!;
  const op = m[1] ?? '';
  const p = partial(m[2]);
  if (!p) return null;
  const lo = floor(p);
  const out: Cmp[] = [];
  const add = (o: Op, v: string | null) => v && out.push({ op: o, v });

  if (op === '^') {
    add('>=', lo);
    if (p.major === undefined) return out;
    if (p.major > 0 || p.minor === undefined) add('<', v3(p.major + 1, 0, 0));
    else if (p.minor > 0 || p.patch === undefined) add('<', v3(0, p.minor + 1, 0));
    else add('<', v3(0, 0, p.patch + 1));
  } else if (op === '~' || op === '~>') {
    add('>=', lo);
    if (p.major === undefined) return out;
    add('<', p.minor === undefined ? v3(p.major + 1, 0, 0) : v3(p.major, p.minor + 1, 0));
  } else if (op === '>') {
    const c = ceil(p);
    if (c) add('>=', c);
    else add('>', lo);
  } else if (op === '>=') {
    add('>=', lo);
  } else if (op === '<') {
    add('<', lo);
  } else if (op === '<=') {
    const c = ceil(p);
    if (c) add('<', c);
    else add('<=', lo);
  } else {
    // exact or x-range
    const c = ceil(p);
    if (c) {
      add('>=', lo);
      add('<', c);
    } else if (p.major === undefined) {
      /* "*" matches everything */
    } else {
      add('=', lo);
    }
  }
  return out;
}

function expandAnd(part: string): Cmp[] | null {
  let r = part.trim().replace(/(>=|<=|>|<|=|\^|~>?)\s+/g, '$1');
  const hy = /^(\S+)\s+-\s+(\S+)$/.exec(r);
  if (hy) {
    const a = partial(hy[1]);
    const b = partial(hy[2]);
    if (!a || !b) return null;
    const c = ceil(b);
    return [{ op: '>=', v: floor(a) }, c ? { op: '<', v: c } : { op: '<=', v: floor(b) }];
  }
  if (r === '' || r === 'latest') r = '*';
  const out: Cmp[] = [];
  for (const tok of r.split(/\s+/)) {
    const e = expand(tok);
    if (!e) return null;
    out.push(...e);
  }
  return out;
}

function test(version: string, c: Cmp): boolean {
  const d = compare(version, c.v);
  switch (c.op) {
    case '>=': return d >= 0;
    case '>': return d > 0;
    case '<': return d < 0;
    case '<=': return d <= 0;
    default: return d === 0;
  }
}

/** npm-style range matching (^ ~ x-ranges, hyphen, comparators, ||). Unparseable ranges return false. */
export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false;
  for (const alt of range.split('||')) {
    const cmps = expandAnd(alt);
    if (!cmps) continue;
    if (!cmps.every((c) => test(version, c))) continue;
    // prerelease versions only match ranges that mention a prerelease of the same x.y.z
    if (v.pre && !cmps.some((c) => { const p = parse(c.v); return !!p?.pre && p.major === v.major && p.minor === v.minor && p.patch === v.patch; })) continue;
    return true;
  }
  return false;
}

/** True when the range is something satisfies() can evaluate. */
export function isRange(range: string): boolean {
  return range.split('||').every((a) => expandAnd(a) !== null);
}
