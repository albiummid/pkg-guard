import { compare, isStable, parse } from '../utils/semver';

export type BumpKind = 'patch' | 'minor' | 'major';

export type BumpTargets = Partial<Record<BumpKind, string>>;

function newest(vs: string[]): string | undefined {
  return vs.reduce<string | undefined>((a, b) => (!a || compare(b, a) > 0 ? b : a), undefined);
}

/**
 * Newest stable version reachable by each kind of bump from `installed`:
 *  - patch: same major.minor, higher patch
 *  - minor: same major, higher minor (the newest of that major, so it already includes later patches)
 *  - major: a higher major (the newest overall)
 */
export function bumpTargets(installed: string, versions: string[]): BumpTargets {
  const cur = parse(installed);
  if (!cur) return {};
  const stable = versions.filter((v) => isStable(v) && compare(v, installed) > 0);
  const at = (v: string) => parse(v)!;
  const out: BumpTargets = {};
  const patch = newest(stable.filter((v) => at(v).major === cur.major && at(v).minor === cur.minor));
  const minor = newest(stable.filter((v) => at(v).major === cur.major && at(v).minor > cur.minor));
  const major = newest(stable.filter((v) => at(v).major > cur.major));
  if (patch) out.patch = patch;
  if (minor) out.minor = minor;
  if (major) out.major = major;
  return out;
}

/** Stable versions newer than `installed`, newest first. */
export function newerVersions(installed: string | undefined, versions: string[]): string[] {
  return versions
    .filter((v) => isStable(v) && (!installed || compare(v, installed) > 0))
    .sort((a, b) => compare(b, a));
}

/** The stable version immediately before `v` (used to read the notes of exactly one release). */
export function previousVersion(v: string, versions: string[]): string | undefined {
  return newest(versions.filter((x) => isStable(x) && compare(x, v) < 0));
}
