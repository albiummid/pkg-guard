export interface Ver {
  major: number;
  minor: number;
  patch: number;
  pre: string;
}

export function parse(v: string): Ver | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  if (!m) return null;
  return { major: +m[1], minor: +(m[2] ?? 0), patch: +(m[3] ?? 0), pre: m[4] ?? '' };
}

function comparePre(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return 1; // release > prerelease
  if (!b) return -1;
  const x = a.split('.');
  const y = b.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const nx = /^\d+$/.test(x[i]);
    const ny = /^\d+$/.test(y[i]);
    if (nx && ny) {
      if (+x[i] !== +y[i]) return +x[i] < +y[i] ? -1 : 1;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x[i] !== y[i]) {
      return x[i] < y[i] ? -1 : 1;
    }
  }
  return 0;
}

/** Returns <0, 0, >0. Unparseable versions compare equal. */
export function compare(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch || comparePre(x.pre, y.pre);
}

export function gt(a: string, b: string): boolean {
  return compare(a, b) > 0;
}

export function major(v: string): number | null {
  return parse(v)?.major ?? null;
}

export function diffKind(from: string, to: string): 'major' | 'minor' | 'patch' | null {
  const a = parse(from);
  const b = parse(to);
  if (!a || !b || compare(from, to) >= 0) return null;
  if (b.major !== a.major) return 'major';
  if (b.minor !== a.minor) return 'minor';
  return 'patch';
}

/** Lowest version a simple range stands for ("^1.2.3" -> "1.2.3", "~1" -> "1.0.0"); null for tags, urls, unions, etc. */
export function baseVersion(range: string): string | null {
  const r = range.trim();
  const m = /^(?:[\^~]|>=|=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(-[0-9A-Za-z.-]+)?$/.exec(r);
  if (!m) return null;
  const n = (s?: string) => (s === undefined || s === 'x' || s === '*' ? '0' : s);
  return `${m[1]}.${n(m[2])}.${n(m[3])}${m[4] ?? ''}`;
}

/** Operator prefix to keep when rewriting a range ("^", "~" or ""). */
export function prefixOf(range: string): string {
  const t = range.trim();
  if (t.startsWith('^')) return '^';
  if (t.startsWith('~')) return '~';
  if (/^(>=|>|<|<=)/.test(t)) return '^';
  return '';
}

export function isStable(v: string): boolean {
  const p = parse(v);
  return !!p && !p.pre;
}
