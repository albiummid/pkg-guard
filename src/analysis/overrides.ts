// Override audit: judges each key of the project's `resolutions` / `overrides` against what the packages requesting it would get without it.
// The verdict logic (judgeOverride) is pure; auditOverrides does the lockfile read, registry lookups and one OSV query.
import * as fs from 'fs';
import * as path from 'path';
import { reportable } from './findings';
import { findLock } from './scan';
import { isBerryLock, LockRequest, lockRequests, npmLockRequests } from '../sources/lockfile';
import { osvQuery } from '../sources/osv';
import { fetchInfo } from '../sources/registry';
import { isRange, satisfies } from '../versions/satisfies';
import { compare, isStable, parse } from '../versions/semver';
import { PackageManager, ScanResult, Settings, Vuln } from '../types';
import { OverrideAudit, OverrideRequest, OverrideRow, RangeRequest } from '../types/overrides';

/** One key of the override section, parsed. */
export interface OverrideKey {
  key: string;
  /** the package it overrides */
  name: string;
  /** scoped key (`**\/parent/pkg`, pnpm `parent>pkg`): only what this package requests is overridden */
  parent?: string;
  /** a key naming a range (`pkg@^1`): only that request is overridden */
  keyRange?: string;
  value: string;
  /** set when the key cannot be audited */
  notChecked?: string;
}

/** Splits `name@range` (the name may be scoped). */
function nameAndRange(s: string): { name: string; range?: string } {
  const at = s.indexOf('@', 1);
  return at < 0 ? { name: s } : { name: s.slice(0, at), range: s.slice(at + 1).replace(/^npm:/, '') };
}

/** Package names of a yarn resolution path (`**\/a/@s/b`), without the globs. */
function pathSegments(key: string): string[] {
  const parts = key.split('/').filter((p) => p && p !== '**');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) out.push(parts[i].startsWith('@') && !parts[i].includes('@', 1) && i + 1 < parts.length ? `${parts[i]}/${parts[++i]}` : parts[i]);
  return out;
}

function parseKey(key: string, value: string, sep: '/' | '>'): OverrideKey {
  const segs = sep === '/' ? pathSegments(key) : key.split('>').map((s) => s.trim());
  const last = nameAndRange(segs[segs.length - 1] ?? key);
  const parent = segs.length > 1 ? nameAndRange(segs[segs.length - 2]).name : undefined;
  return { key, name: last.name, ...(parent ? { parent } : {}), ...(last.range ? { keyRange: last.range } : {}), value };
}

/** The keys of the package manager's override section in a manifest. npm nested objects are not audited; `$dep` takes the dependency's range. */
export function overrideKeys(manifest: any, pm: PackageManager): OverrideKey[] {
  const section = pm.overrideSection === 'pnpm.overrides' ? manifest?.pnpm?.overrides : manifest?.[pm.overrideSection];
  if (!section || typeof section !== 'object') return [];
  const own: Record<string, string> = { ...manifest.optionalDependencies, ...manifest.devDependencies, ...manifest.dependencies };
  const out: OverrideKey[] = [];
  for (const [key, raw] of Object.entries<unknown>(section)) {
    if (pm.name === 'npm' || pm.name === 'bun') {
      if (typeof raw === 'string') {
        const ref = raw.startsWith('$') ? own[raw.slice(1)] : raw;
        out.push({ ...parseKey(key, ref ?? raw, '/'), ...(ref === undefined ? { notChecked: `${raw} names no dependency of package.json` } : {}) });
      } else out.push({ ...parseKey(key, '', '/'), notChecked: 'nested overrides are not checked' });
    } else if (typeof raw === 'string') out.push(parseKey(key, raw, pm.name === 'pnpm' ? '>' : '/'));
    else out.push({ ...parseKey(key, '', '/'), notChecked: 'the value is not a version range' });
  }
  return out;
}

/** The ranges in the lockfile the key applies to, each with the packages requesting it. */
export function requestsFor(k: OverrideKey, reqs: LockRequest[]): RangeRequest[] {
  const out = new Map<string, string[]>();
  for (const q of reqs) {
    if (q.name !== k.name || (k.parent !== undefined && q.by !== k.parent) || (k.keyRange !== undefined && q.range !== k.keyRange)) continue;
    const by = out.get(q.range) ?? [];
    if (!by.includes(q.by)) by.push(q.by);
    out.set(q.range, by);
  }
  return [...out].map(([range, by]) => ({ range, by }));
}

/** Newest published version a range allows, stable first: what a fresh install would get. */
export function freshVersion(range: string, versions: string[]): string | undefined {
  if (!isRange(range)) return undefined;
  const ok = versions.filter((v) => satisfies(v, range));
  const pool = ok.some(isStable) ? ok.filter(isStable) : ok;
  return pool.length ? pool.reduce((a, b) => (compare(b, a) > 0 ? b : a)) : undefined;
}

/**
 * Whether `range` shares no published version with the override's `value`: some version satisfying both means they intersect.
 * Undefined (not checked) when either side is not a range or matches no published version, so there is no data to judge the pair by.
 */
function outsideRange(value: string, range: string, versions: string[]): boolean | undefined {
  if (!isRange(value) || !isRange(range)) return undefined;
  const allowed = versions.filter((v) => satisfies(v, range));
  if (!allowed.length || !versions.some((v) => satisfies(v, value))) return undefined;
  return !allowed.some((v) => satisfies(v, value));
}

export interface JudgeInput {
  key: string;
  name: string;
  value: string;
  requests: RangeRequest[];
  /** published versions of the package; undefined when the registry lookup failed */
  versions?: string[];
  /** Advisory ids by version (a missing version has none); undefined when the advisory lookup failed */
  advisories?: Map<string, string[]>;
  notChecked?: string;
}

/**
 * Verdict of one override key. A request at the override's own range is the key itself (or asks for exactly what it forces), so it is left out.
 *
 * Precedence (decided in #35):
 * 1. forces-other-major: the override's range shares no published version with some requester's range, and that requester would get a
 *    version with no Advisory without the override (it is moved off its range for nothing);
 * 2. still-needed: otherwise, any requester would get a version with an Advisory without it. This wins even when that requester's own
 *    range does not intersect the override's: leaving its range is then the price of the fix;
 * 3. redundant: otherwise.
 *
 * A pair whose intersection cannot be checked (no published version data for one side) is never counted as forcing.
 */
export function judgeOverride(i: JudgeInput): OverrideRow {
  const row = (r: Partial<OverrideRow>): OverrideRow => ({ key: i.key, name: i.name, value: i.value, verdict: 'not-checked', requests: [], ...r });
  if (i.notChecked) return row({ reason: i.notChecked });
  const others = i.requests.filter((q) => q.range !== i.value);
  if (!i.requests.length) return row({ verdict: 'unused' });
  if (!i.versions) return row({ reason: 'registry lookup failed' });
  const forced = freshVersion(i.value, i.versions) ?? (parse(i.value) ? i.value : undefined);
  if (!forced) return row({ reason: `no published version matches ${i.value}` });
  const requests: OverrideRequest[] = others.map((q) => {
    const fresh = freshVersion(q.range, i.versions!);
    return { range: q.range, by: q.by, fresh, advisories: (fresh && i.advisories?.get(fresh)) || [], outsideRange: outsideRange(i.value, q.range, i.versions!) };
  });
  if (!i.advisories) return row({ forced, requests, reason: 'advisory lookup failed' });
  if (!requests.length) return row({ verdict: 'redundant', forced, requests });
  if (!requests.some((q) => q.fresh)) return row({ forced, requests, reason: 'the requested ranges match no published version' });
  const verdict = requests.some((q) => q.outsideRange === true && !q.advisories.length) ? 'forces-other-major' : requests.some((q) => q.advisories.length) ? 'still-needed' : 'redundant';
  return row({ verdict, forced, requests });
}

const LOCKFILE: Record<string, OverrideAudit['lockfile']> = { npm: 'npm', pnpm: 'pnpm', bun: 'bun' };

/** Audits the override section of the manifest `text` (network: registry, OSV). Undefined when it has no entries. */
export async function auditOverrides(text: string, pkgFile: string, r: ScanResult, s: Settings): Promise<OverrideAudit | undefined> {
  let manifest: any;
  try {
    manifest = JSON.parse(text);
  } catch {
    return undefined;
  }
  const keys = overrideKeys(manifest, r.pm);
  if (!keys.length) return undefined;
  const audit = (lockfile: OverrideAudit['lockfile'], rows: OverrideRow[]): OverrideAudit => ({ section: r.pm.overrideSection, lockfile, rows });
  const skipAll = (lockfile: OverrideAudit['lockfile'], reason: string) => audit(lockfile, keys.map((k) => judgeOverride({ ...k, requests: [], notChecked: k.notChecked ?? reason })));

  const dir = path.dirname(pkgFile);
  const lock = await findLock(dir);
  if (!lock || lock.pm !== r.pm.name) return skipAll('none', 'no lockfile to compare with');
  if (lock.kind === 'pnpm' || lock.kind === 'bun' || !lock.kind) return skipAll(LOCKFILE[lock.pm] ?? 'none', `${path.basename(lock.file)} lockfiles are not checked`);
  let reqs: LockRequest[] | null;
  let lockfile: OverrideAudit['lockfile'];
  try {
    const lockText = await fs.promises.readFile(lock.file, 'utf8');
    lockfile = lock.kind === 'yarn' ? (isBerryLock(lockText) ? 'yarn-berry' : 'yarn-classic') : 'npm';
    reqs = lock.kind === 'yarn' ? lockRequests(lockText) : npmLockRequests(JSON.parse(lockText));
  } catch {
    return skipAll('none', `${path.basename(lock.file)} could not be read`);
  }
  if (!reqs) return skipAll(lockfile, lockfile === 'npm' ? `${path.basename(lock.file)} v1 (no "packages" section) is not checked` : `${path.basename(lock.file)} could not be read`);

  const inputs = keys.map((k): JudgeInput => ({ ...k, requests: k.notChecked ? [] : requestsFor(k, reqs!) }));
  const names = [...new Set(inputs.filter((x) => !x.notChecked && x.requests.length).map((x) => x.name))];
  const infos = new Map(await Promise.all(names.map(async (n) => [n, await fetchInfo(n, s.registry, { dir, trusted: s.trusted })] as const)));
  for (const x of inputs) x.versions = infos.get(x.name)?.versions;

  // one OSV query over every version the requesters would get without the overrides
  const fresh = new Map<string, { name: string; version: string }>();
  for (const x of inputs) for (const q of x.versions ? x.requests : []) {
    const v = freshVersion(q.range, x.versions!);
    if (v) fresh.set(`${x.name}@${v}`, { name: x.name, version: v });
  }
  let found: Map<string, Vuln[]> | undefined;
  try {
    found = fresh.size ? await osvQuery([...fresh.values()]) : new Map();
  } catch {
    found = undefined;
  }
  const reported = reportable(s);
  for (const x of inputs) {
    if (!found) continue;
    const byVersion = new Map<string, string[]>();
    for (const [key, vulns] of found) {
      if (!key.startsWith(`${x.name}@`)) continue;
      const ids = vulns.filter(reported).map((v) => v.id);
      if (ids.length) byVersion.set(key.slice(x.name.length + 1), ids);
    }
    x.advisories = byVersion;
  }
  return audit(lockfile, inputs.map(judgeOverride));
}
