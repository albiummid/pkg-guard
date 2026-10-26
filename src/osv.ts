import { compare } from './semver';
import { Severity, Vuln } from './types';

const OSV = 'https://api.osv.dev/v1';
const TTL = 6 * 60 * 60 * 1000;
const idCache = new Map<string, { t: number; ids: string[] }>();
const detailCache = new Map<string, any>();

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

export function toVuln(d: any, pkg: string, version: string): Vuln {
  const id: string = d.id;
  return {
    id,
    url: id.startsWith('GHSA-') ? `https://github.com/advisories/${id}` : `https://osv.dev/vulnerability/${id}`,
    summary: d.summary ?? d.details?.split('\n')[0] ?? id,
    severity: normSeverity(d.database_specific?.severity),
    fixedIn: fixedFor(d.affected, pkg, version),
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

/** Throws when OSV is unreachable so the caller can fall back to an audit CLI. Keys are "name@version". */
export async function osvQuery(pkgs: { name: string; version: string }[]): Promise<Map<string, Vuln[]>> {
  const unique = [...new Map(pkgs.filter((p) => p.version).map((p) => [`${p.name}@${p.version}`, p])).values()];
  const now = Date.now();
  const need = unique.filter((p) => {
    const c = idCache.get(`${p.name}@${p.version}`);
    return !c || now - c.t > TTL;
  });
  for (let i = 0; i < need.length; i += 1000) {
    const chunk = need.slice(i, i + 1000);
    const res = await post(`${OSV}/querybatch`, {
      queries: chunk.map((p) => ({ package: { name: p.name, ecosystem: 'npm' }, version: p.version })),
    });
    chunk.forEach((p, k) => {
      const ids = (res.results?.[k]?.vulns ?? []).map((v: any) => v.id as string);
      idCache.set(`${p.name}@${p.version}`, { t: now, ids });
    });
  }
  const ids = new Set<string>();
  for (const p of unique) idCache.get(`${p.name}@${p.version}`)!.ids.forEach((x) => ids.add(x));
  await pool([...ids].filter((x) => !detailCache.has(x)), 8, async (id) => {
    try {
      const r = await fetch(`${OSV}/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(20000) });
      detailCache.set(id, r.ok ? await r.json() : { id });
    } catch {
      detailCache.set(id, { id });
    }
  });
  const out = new Map<string, Vuln[]>();
  for (const p of unique) {
    const list: Vuln[] = [];
    for (const id of idCache.get(`${p.name}@${p.version}`)!.ids) {
      const d = detailCache.get(id);
      if (d?.withdrawn) continue;
      list.push(toVuln(d, p.name, p.version));
    }
    if (list.length) out.set(`${p.name}@${p.version}`, list);
  }
  return out;
}
