import { compare, gt, isStable, major } from './semver';

export interface Manifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  engines?: { node?: string };
  deprecated?: string;
}

export interface RegistryInfo {
  latest?: string;
  versions: string[];
  deprecated: Record<string, string>;
  manifests: Record<string, Manifest>;
}

const TTL = 60 * 60 * 1000;
const cache = new Map<string, { t: number; info: RegistryInfo | null }>();

export function clearRegistryCache(): void {
  cache.clear();
}

export async function fetchInfo(name: string, registry: string): Promise<RegistryInfo | null> {
  const key = `${registry}|${name}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.info;
  let info: RegistryInfo | null = null;
  try {
    const url = `${registry.replace(/\/$/, '')}/${name.replace('/', '%2f')}`;
    const res = await fetch(url, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const j: any = await res.json();
      const deprecated: Record<string, string> = {};
      const manifests: Record<string, Manifest> = {};
      for (const [v, m] of Object.entries<any>(j.versions ?? {})) {
        if (m?.deprecated) deprecated[v] = String(m.deprecated);
        manifests[v] = { dependencies: m.dependencies, peerDependencies: m.peerDependencies, peerDependenciesMeta: m.peerDependenciesMeta, engines: m.engines, deprecated: m.deprecated };
      }
      info = { latest: j['dist-tags']?.latest, versions: Object.keys(j.versions ?? {}), deprecated, manifests };
    }
  } catch {
    info = null;
  }
  cache.set(key, { t: Date.now(), info });
  return info;
}

export interface Suggestion {
  /** newest stable version with the same major as installed (only if newer than installed) */
  inMajor?: string;
  /** newest stable version overall, only if it crosses a major */
  nextMajor?: string;
}

export function suggest(installed: string, info: RegistryInfo): Suggestion {
  const stable = info.versions.filter(isStable);
  const m = major(installed);
  let inMajor: string | undefined;
  for (const v of stable) if (major(v) === m && gt(v, installed) && (!inMajor || gt(v, inMajor))) inMajor = v;
  let top = info.latest && isStable(info.latest) ? info.latest : undefined;
  for (const v of stable) if (!top || compare(v, top) > 0) top = v;
  const nextMajor = top && m !== null && (major(top) ?? 0) > m ? top : undefined;
  return { inMajor, nextMajor };
}

/** Newest stable version >= `min`, preferring the installed major (a fix is usually followed by more patches). */
export function pickAtLeast(min: string, installed: string, info: RegistryInfo | null): string {
  if (!info) return min;
  const stable = info.versions.filter((v) => isStable(v) && compare(v, min) >= 0);
  const sameMajor = stable.filter((v) => major(v) === major(min));
  const pool = sameMajor.length ? sameMajor : stable;
  if (!pool.length) return min;
  return pool.reduce((a, b) => (gt(b, a) ? b : a));
}
