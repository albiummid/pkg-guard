import { compare } from '../versions/semver';
import { Severity, Vuln } from '../types/index';

const OSV = 'https://api.osv.dev/v1';
const TTL = 6 * 60 * 60 * 1000;
const MAX_PAGES = 50;
const idCache = new Map<string, { t: number; ids: string[] }>();
const detailCache = new Map<string, any>();
/** Requests in flight, so concurrent scans (a monorepo refresh) ask OSV once. */
const idInflight = new Map<string, Promise<void>>();
const detailInflight = new Map<string, Promise<void>>();

export function clearOsvCache(): void {
  idCache.clear();
  detailCache.clear();
}

export function normSeverity(s: unknown): Severity {
  switch (String(s ?? '').toUpperCase()) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'high';
    case 'MODERATE':
    case 'MEDIUM':
      return 'moderate';
    case 'LOW':
      return 'low';
    default:
      return 'unknown';
  }
}

const roundUp = (x: number): number => {
  const i = Math.round(x * 100000);
  return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10;
};

/** Base score of a CVSS v3.x vector; undefined for anything else (v4, malformed). */
export function cvssScore(vector: string): number | undefined {
  const m = /^CVSS:3\.[01]\/(.+)$/.exec(vector.trim());
  if (!m) return undefined;
  const v: Record<string, string> = {};
  for (const part of m[1].split('/')) {
    const [k, val] = part.split(':');
    v[k] = val;
  }
  const changed = v.S === 'C';
  if (v.S !== 'C' && v.S !== 'U') return undefined;
  const AV = ({ N: 0.85, A: 0.62, L: 0.55, P: 0.2 } as Record<string, number>)[v.AV];
  const AC = ({ L: 0.77, H: 0.44 } as Record<string, number>)[v.AC];
  const PR = ({ N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 } as Record<string, number>)[v.PR];
  const UI = ({ N: 0.85, R: 0.62 } as Record<string, number>)[v.UI];
  const cia = (k: string) => ({ H: 0.56, L: 0.22, N: 0 } as Record<string, number>)[v[k]];
  const [C, I, A] = [cia('C'), cia('I'), cia('A')];
  if ([AV, AC, PR, UI, C, I, A].some((x) => x === undefined)) return undefined;
  const iss = 1 - (1 - C) * (1 - I) * (1 - A);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * AV * AC * PR * UI;
  return roundUp(Math.min(changed ? 1.08 * (impact + exploitability) : impact + exploitability, 10));
}

/** The rated severity when the advisory has one; malware is critical; otherwise the CVSS v3 score; otherwise unknown. */
export function severityOf(d: any): Severity {
  const rated = normSeverity(d?.database_specific?.severity);
  if (rated !== 'unknown') return rated;
  if (String(d?.id ?? '').startsWith('MAL-')) return 'critical';
  for (const s of d?.severity ?? []) {
    const score = typeof s?.score === 'string' ? cvssScore(s.score) : undefined;
    if (score !== undefined) return score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'moderate' : 'low';
  }
  return 'unknown';
}

/** First "fixed" version of the affected range that contains `version`. */
export function fixedFor(affected: any[] | undefined, name: string, version: string): string | undefined {
  for (const a of affected ?? []) {
    if (a.package?.name !== name) continue;
    for (const r of a.ranges ?? []) {
      if (r.type !== 'SEMVER' && r.type !== 'ECOSYSTEM') continue;
      let intro = '0';
      for (const ev of r.events ?? []) {
        if (ev.introduced !== undefined) intro = ev.introduced;
        if (ev.fixed && compare(version, intro) >= 0 && compare(version, ev.fixed) < 0) return ev.fixed;
      }
    }
  }
  return undefined;
}

/** Version an OSV range event stands for ("0" is below every version). */
const eventVersion = (ev: any): string | undefined => ev.introduced ?? ev.fixed ?? ev.last_affected;

/** True when an OSV `affected` list covers `version` of `name`, through its explicit versions or its SEMVER / ECOSYSTEM ranges. */
export function isAffected(affected: any[] | undefined, name: string, version: string): boolean {
  for (const a of affected ?? []) {
    if (a.package?.name !== name) continue;
    if (Array.isArray(a.versions) && a.versions.includes(version)) return true;
    for (const r of a.ranges ?? []) {
      if (r.type !== 'SEMVER' && r.type !== 'ECOSYSTEM') continue;
      // the evaluation in the OSV schema: walk the events in version order, opening at "introduced", closing at "fixed" or after "last_affected"
      const events = (r.events ?? []).filter((ev: any) => eventVersion(ev) !== undefined).sort((x: any, y: any) => compare(eventVersion(x)!, eventVersion(y)!));
      let hit = false;
      for (const ev of events) {
        if (ev.introduced !== undefined) {
          if (ev.introduced === '0' || compare(version, ev.introduced) >= 0) hit = true;
        } else if (ev.fixed !== undefined) {
          if (compare(version, ev.fixed) >= 0) hit = false;
        } else if (compare(version, ev.last_affected) > 0) {
          hit = false;
        }
      }
      if (hit) return true;
    }
  }
  return false;
}

export function toVuln(d: any, pkg: string, version: string): Vuln {
  const id: string = d.id;
  return {
    id,
    url: id.startsWith('GHSA-') ? `https://github.com/advisories/${id}` : `https://osv.dev/vulnerability/${id}`,
    summary: d.summary ?? d.details?.split('\n')[0] ?? id,
    severity: severityOf(d),
    fixedIn: fixedFor(d.affected, pkg, version),
    aliases: Array.isArray(d.aliases) && d.aliases.length ? d.aliases.map(String) : undefined,
    pkg,
    version,
  };
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

async function post(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`OSV ${res.status}`);
  return res.json();
}

/**
 * `allowed` is set when nothing is installed: the package is then asked for with no version, which returns every Advisory it has,
 * and each Advisory is matched here against these published versions the Declared range allows.
 */
type Pkg = { name: string; version: string; allowed?: string[] };
/** Key of the result: the version checked (the Floor version when `allowed` is set). */
const keyOf = (p: Pkg) => `${p.name}@${p.version}`;
/** Key of the OSV query and its cached ids; the query with no version is shared by every range of the package. */
const queryOf = (p: Pkg) => (p.allowed ? `${p.name}@` : keyOf(p));

/** Asks OSV for the advisory ids of one chunk of packages, following result pages. Throws when OSV fails. */
async function fetchIds(chunk: Pkg[]): Promise<void> {
  const query = (p: Pkg, page_token?: string) => ({ package: { name: p.name, ecosystem: 'npm' }, ...(p.allowed ? {} : { version: p.version }), ...(page_token ? { page_token } : {}) });
  const res = await post(`${OSV}/querybatch`, { queries: chunk.map((p) => query(p)) });
  for (let k = 0; k < chunk.length; k++) {
    const ids: string[] = (res.results?.[k]?.vulns ?? []).map((v: any) => v.id as string);
    let token: string | undefined = res.results?.[k]?.next_page_token;
    for (let page = 0; token && page < MAX_PAGES; page++) {
      const next = await post(`${OSV}/querybatch`, { queries: [query(chunk[k], token)] });
      ids.push(...(next.results?.[0]?.vulns ?? []).map((v: any) => v.id as string));
      token = next.results?.[0]?.next_page_token;
    }
    idCache.set(queryOf(chunk[k]), { t: Date.now(), ids });
  }
}

/** Fetches one advisory. A failure is not cached, so the next scan tries again instead of keeping an advisory without severity or fix. */
function fetchDetail(id: string): Promise<void> {
  const running = detailInflight.get(id);
  if (running) return running;
  const p = (async () => {
    try {
      const r = await fetch(`${OSV}/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(20000) });
      if (r.ok) detailCache.set(id, await r.json());
    } catch {
      /* left uncached on purpose */
    }
  })();
  detailInflight.set(id, p);
  void p.then(() => detailInflight.delete(id));
  return p;
}

/**
 * The Vulnerability of Advisory `d` across the allowed versions it affects, or undefined when it affects none. Its fixed version
 * clears all of them, so it is only known when each affected version has one.
 */
function allowedVuln(d: any, p: Pkg): Vuln | undefined {
  const hit = (p.allowed ?? []).filter((v) => isAffected(d.affected, p.name, v)).sort(compare);
  if (!hit.length) return undefined;
  const fixes = hit.map((v) => fixedFor(d.affected, p.name, v));
  const fixedIn = fixes.every((f): f is string => !!f) ? fixes.reduce((a, b) => (compare(b, a) > 0 ? b : a)) : undefined;
  return { ...toVuln(d, p.name, p.version), fixedIn, affected: hit };
}

/**
 * Throws when OSV is unreachable so the caller can fall back to an audit CLI. Keys are "name@version". A package with `allowed`
 * costs the same one query as any other. An Advisory whose details could not be fetched has no ranges to match, so it is left
 * out for such a package until a later scan fetches them.
 */
export async function osvQuery(pkgs: Pkg[]): Promise<Map<string, Vuln[]>> {
  const unique = [...new Map(pkgs.filter((p) => p.version).map((p) => [keyOf(p), p])).values()];
  const queries = [...new Map(unique.map((p) => [queryOf(p), p])).values()];
  const now = Date.now();
  const stale = queries.filter((p) => {
    const c = idCache.get(queryOf(p));
    return !c || now - c.t > TTL;
  });
  const waits: Promise<void>[] = [];
  const toFetch: Pkg[] = [];
  for (const p of stale) {
    const running = idInflight.get(queryOf(p));
    if (running) waits.push(running);
    else toFetch.push(p);
  }
  for (let i = 0; i < toFetch.length; i += 1000) {
    const chunk = toFetch.slice(i, i + 1000);
    const p = fetchIds(chunk);
    for (const c of chunk) idInflight.set(queryOf(c), p);
    const done = () => chunk.forEach((c) => idInflight.delete(queryOf(c)));
    void p.then(done, done);
    waits.push(p);
  }
  await Promise.all(waits);

  const ids = new Set<string>();
  for (const p of queries) idCache.get(queryOf(p))?.ids.forEach((x) => ids.add(x));
  await pool([...ids].filter((x) => !detailCache.has(x)), 8, fetchDetail);

  const out = new Map<string, Vuln[]>();
  for (const p of unique) {
    const list: Vuln[] = [];
    for (const id of idCache.get(queryOf(p))?.ids ?? []) {
      const d = detailCache.get(id) ?? { id };
      if (d.withdrawn) continue;
      const v = p.allowed ? allowedVuln(d, p) : toVuln(d, p.name, p.version);
      if (v) list.push(v);
    }
    if (list.length) out.set(keyOf(p), list);
  }
  return out;
}
