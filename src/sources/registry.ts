import { compare, gt, isStable, major } from '../versions/semver';
import { NpmrcScope, resolveRegistry } from './npmrc';
import { Manifest, RegistryInfo, Suggestion } from '../types';

const TTL = 60 * 60 * 1000;
/** A failure that may be temporary (rate limit, timeout, 5xx) is only remembered briefly. */
const RETRY_TTL = 60 * 1000;
const cache = new Map<string, { t: number; ttl: number; info: RegistryInfo | null }>();
const inflight = new Map<string, Promise<RegistryInfo | null>>();

export function clearRegistryCache(): void {
  cache.clear();
}

/** `registry` is the configured default; a scope mapped in .npmrc wins over it, and .npmrc credentials go only to the registry they belong to. */
export function fetchInfo(name: string, registry: string, scope?: NpmrcScope): Promise<RegistryInfo | null> {
  const r = resolveRegistry(name, registry, scope);
  if (!r.registry) return Promise.resolve(null);
  const key = `${r.registry}|${r.authorization ? 'auth|' : ''}${name}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < hit.ttl) return Promise.resolve(hit.info);
  const running = inflight.get(key);
  if (running) return running;
  const p = load(name, r.registry, r.authorization, key);
  inflight.set(key, p);
  void p.then(() => inflight.delete(key));
  return p;
}

/** Large packuments (over 10 MB) need a generous timeout; a timeout, network error or 5xx is retried once. */
async function fetchPackument(name: string, registry: string, authorization: string | undefined): Promise<Response> {
  const url = `${registry.replace(/\/$/, '')}/${name.replace('/', '%2f')}`;
  const get = () => fetch(url, { headers: { accept: 'application/vnd.npm.install-v1+json', ...(authorization ? { authorization } : {}) }, signal: AbortSignal.timeout(30000) });
  try {
    const res = await get();
    if (res.status < 500) return res;
  } catch {
    /* retried below */
  }
  return get();
}

async function load(name: string, registry: string, authorization: string | undefined, key: string): Promise<RegistryInfo | null> {
  let info: RegistryInfo | null = null;
  let ttl = TTL;
  try {
    const res = await fetchPackument(name, registry, authorization);
    if (res.ok) {
      const j: any = await res.json();
      const deprecated: Record<string, string> = {};
      const manifests: Record<string, Manifest> = {};
      for (const [v, m] of Object.entries<any>(j.versions ?? {})) {
        if (m?.deprecated) deprecated[v] = String(m.deprecated);
        manifests[v] = { dependencies: m.dependencies, peerDependencies: m.peerDependencies, peerDependenciesMeta: m.peerDependenciesMeta, engines: m.engines, deprecated: m.deprecated };
      }
      info = { latest: j['dist-tags']?.latest, versions: Object.keys(j.versions ?? {}), deprecated, manifests };
    } else if (res.status !== 404) {
      ttl = RETRY_TTL;
    }
  } catch {
    info = null;
    ttl = RETRY_TTL;
  }
  cache.set(key, { t: Date.now(), ttl, info });
  return info;
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
export function pickAtLeast(min: string, _installed: string, info: RegistryInfo | null): string {
  if (!info) return min;
  const stable = info.versions.filter((v) => isStable(v) && compare(v, min) >= 0);
  const sameMajor = stable.filter((v) => major(v) === major(min));
  const pool = sameMajor.length ? sameMajor : stable;
  if (!pool.length) return min;
  return pool.reduce((a, b) => (gt(b, a) ? b : a));
}
