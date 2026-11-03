import { Manifest } from './registry';
import { baseVersion, gt, isStable } from '../utils/semver';
import { isRange, satisfies } from '../utils/satisfies';

export interface Dependent {
  /** installed package that declares a peer dependency on the package being updated */
  name: string;
  version: string;
  peerRange: string;
  optional?: boolean;
  /** newest stable version of the dependent whose peer range accepts the target (if any, and newer than `version`) */
  fixedBy?: string;
}

export interface CompatInput {
  name: string;
  installed?: string;
  target: string;
  current?: Manifest;
  next?: Manifest;
  /** version of another package in this project (lockfile / node_modules), if any */
  installedOf: (dep: string) => string | undefined;
  /** engines.node declared by the project, if any */
  projectNode?: string;
  dependents: Dependent[];
}

export interface Issue {
  level: 'error' | 'warning' | 'info';
  text: string;
}

export interface Companion {
  name: string;
  from: string;
  to: string;
  reason: string;
}

export interface CompatReport {
  issues: Issue[];
  companions: Companion[];
}

export function checkCompat(i: CompatInput): CompatReport {
  const issues: Issue[] = [];
  const companions: Companion[] = [];
  const next = i.next ?? {};

  if (next.deprecated) issues.push({ level: 'warning', text: `${i.name}@${i.target} is deprecated: ${next.deprecated}` });

  // 1. what the new version needs from the project
  for (const [peer, range] of Object.entries(next.peerDependencies ?? {})) {
    const optional = !!next.peerDependenciesMeta?.[peer]?.optional;
    const have = i.installedOf(peer);
    if (!isRange(range)) continue;
    if (!have) {
      if (!optional) issues.push({ level: 'warning', text: `needs peer ${peer} ${range}, which is not installed` });
    } else if (!satisfies(have, range)) {
      issues.push({ level: optional ? 'warning' : 'error', text: `needs peer ${peer} ${range}, but ${have} is installed` });
    }
  }

  // 2. runtime requirement
  const needNode = next.engines?.node;
  if (needNode && i.projectNode && isRange(needNode)) {
    const base = baseVersion(i.projectNode);
    if (base && !satisfies(base, needNode)) {
      issues.push({ level: 'warning', text: `requires Node ${needNode}, but the project allows ${i.projectNode}` });
    }
  }

  // 3. its own dependencies versus what the project already pins
  const before = i.current?.dependencies ?? {};
  const after = next.dependencies ?? {};
  const added = Object.keys(after).filter((d) => !(d in before));
  const removed = Object.keys(before).filter((d) => !(d in after));
  if (added.length || removed.length) {
    const parts = [added.length ? `adds ${added.length} (${added.slice(0, 5).join(', ')}${added.length > 5 ? ', …' : ''})` : '', removed.length ? `removes ${removed.length} (${removed.slice(0, 5).join(', ')}${removed.length > 5 ? ', …' : ''})` : ''];
    issues.push({ level: 'info', text: `dependencies: ${parts.filter(Boolean).join('; ')}` });
  }
  for (const [d, range] of Object.entries(after)) {
    const have = i.installedOf(d);
    if (have && isRange(range) && !satisfies(have, range) && (before[d] !== range)) {
      issues.push({ level: 'info', text: `now depends on ${d} ${range}; the project has ${have}, so a second copy may be installed` });
    }
  }

  // 4. installed packages whose peer range would reject the new version
  for (const d of i.dependents) {
    if (!isRange(d.peerRange) || satisfies(i.target, d.peerRange)) continue;
    const level = d.optional ? 'warning' : 'error';
    if (d.fixedBy) {
      issues.push({ level, text: `${d.name}@${d.version} peers on ${i.name} ${d.peerRange} — update ${d.name} to ${d.fixedBy}` });
      companions.push({ name: d.name, from: d.version, to: d.fixedBy, reason: `peer ${i.name} ${d.peerRange}` });
    } else {
      issues.push({ level, text: `${d.name}@${d.version} peers on ${i.name} ${d.peerRange} and no newer ${d.name} accepts ${i.target}` });
    }
  }
  return { issues, companions };
}

/** Newest stable version of a dependent whose peer range for `peerName` accepts `target`, and that is newer than `current`. */
export function findCompanion(
  versions: string[],
  manifests: Record<string, Manifest>,
  peerName: string,
  target: string,
  current: string,
): string | undefined {
  let best: string | undefined;
  for (const v of versions) {
    if (!isStable(v) || !gt(v, current)) continue;
    const range = manifests[v]?.peerDependencies?.[peerName];
    if (range === undefined || (isRange(range) && satisfies(target, range))) {
      if (!best || gt(v, best)) best = v;
    }
  }
  return best;
}

export function formatReport(name: string, from: string | undefined, to: string, r: CompatReport): string {
  const icon = { error: '✖', warning: '⚠', info: 'ℹ' } as const;
  const lines = [`${name} ${from ?? '?'} → ${to}`, ''];
  if (!r.issues.length) lines.push('✔ No compatibility problems found.');
  for (const lvl of ['error', 'warning', 'info'] as const) for (const x of r.issues.filter((y) => y.level === lvl)) lines.push(`${icon[lvl]} ${x.text}`);
  if (r.companions.length) {
    lines.push('', 'Companion updates:');
    for (const c of r.companions) lines.push(`  • ${c.name} ${c.from} → ${c.to}  (${c.reason})`);
  }
  return lines.join('\n');
}
