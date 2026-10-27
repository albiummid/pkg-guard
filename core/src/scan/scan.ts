import * as fs from 'fs';
import * as path from 'path';
import { attribute, runAudit } from '../vulnerabilities/audit';
import { buildNpmGraph, buildYarnGraph } from '../vulnerabilities/lockfile';
import { osvQuery } from '../vulnerabilities/osv';
import { DepEntry, locateDeps } from '../manifest/packageJson';
import { fetchInfo, RegistryInfo } from '../updates/registry';
import { baseVersion } from '../utils/semver';
import { detectPm, PackageManager } from '../manifest/pm';
import { Graph, Hit } from '../types';

export interface Settings {
  enableVulnerabilities: boolean;
  checkTransitive: boolean;
  enableOutdated: boolean;
  showMajorUpdates: boolean;
  minSeverity: 'low' | 'moderate' | 'high' | 'critical';
  auditFallback: boolean;
  registry: string;
  ignoredAdvisories: string[];
  ignoredPackages: string[];
}

export interface ScanResult {
  entries: DepEntry[];
  installed: Map<string, string>;
  hits: Hit[];
  info: Map<string, RegistryInfo>;
  lock: Graph['kind'];
  pm: PackageManager;
  source: 'osv' | 'audit' | 'none';
  notes: string[];
}

const SKIP_RANGE = /^(workspace:|file:|link:|git|http|npm:|github:|portal:|patch:|catalog:)|\//;

function findLock(dir: string): { file: string; kind: 'yarn' | 'npm' } | null {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'yarn.lock'))) return { file: path.join(d, 'yarn.lock'), kind: 'yarn' };
    if (fs.existsSync(path.join(d, 'package-lock.json'))) return { file: path.join(d, 'package-lock.json'), kind: 'npm' };
    if (path.dirname(d) === d) return null;
  }
}

/** package.json of an installed package, resolved like node does (this folder's node_modules, then parents'). */
export function readInstalledPkg(dir: string, name: string): any | undefined {
  for (let d = dir; ; d = path.dirname(d)) {
    try {
      return JSON.parse(fs.readFileSync(path.join(d, 'node_modules', name, 'package.json'), 'utf8'));
    } catch {
      /* keep walking up */
    }
    if (path.dirname(d) === d) return undefined;
  }
}

function installedFromNodeModules(dir: string, name: string): string | undefined {
  return readInstalledPkg(dir, name)?.version;
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

export async function scan(text: string, pkgFile: string, s: Settings): Promise<ScanResult> {
  const notes: string[] = [];
  const entries = locateDeps(text);
  const result: ScanResult = { entries, installed: new Map(), hits: [], info: new Map(), lock: 'none', pm: detectPm(path.dirname(pkgFile)), source: 'none', notes };
  let pkg: any;
  try {
    pkg = JSON.parse(text);
  } catch {
    notes.push('package.json is not valid JSON yet');
    return result;
  }
  const dir = path.dirname(pkgFile);
  result.pm = detectPm(dir, pkg);
  const rootDeps: Record<string, string> = {
    ...pkg.optionalDependencies,
    ...pkg.devDependencies,
    ...pkg.dependencies,
  };

  // 1. resolve what is actually installed (lockfile > node_modules > range)
  let graph: Graph | null = null;
  const lock = findLock(dir);
  try {
    if (lock?.kind === 'yarn') graph = buildYarnGraph(fs.readFileSync(lock.file, 'utf8'), rootDeps);
    if (lock?.kind === 'npm') graph = buildNpmGraph(JSON.parse(fs.readFileSync(lock.file, 'utf8')), rootDeps);
  } catch (e) {
    notes.push(`could not read lockfile: ${e}`);
  }
  if (lock && !graph) notes.push('lockfile format not supported (yarn berry / package-lock v1?); transitive checks disabled');
  const g: Graph = graph ?? { kind: 'none', nodes: new Map(), roots: new Map() };
  result.lock = g.kind;
  for (const e of entries) {
    const rid = g.roots.get(e.name);
    const v =
      (rid && g.nodes.get(rid)?.version) ||
      installedFromNodeModules(dir, e.name) ||
      (SKIP_RANGE.test(e.range) ? undefined : baseVersion(e.range) ?? undefined);
    if (v) result.installed.set(e.name, v);
    if (!rid && v) {
      // no lockfile: synthesize a root node so the vulnerability lookup still works
      const id = `${e.name}@${v}`;
      g.nodes.set(id, { id, name: e.name, version: v, deps: [] });
      g.roots.set(e.name, id);
    }
  }

  // 2. vulnerabilities
  if (s.enableVulnerabilities) {
    try {
      let nodes = [...g.nodes.values()];
      if (!s.checkTransitive || g.kind === 'none') nodes = [...g.roots.values()].map((id) => g.nodes.get(id)!);
      const vulns = await osvQuery(nodes);
      result.hits = attribute(g, vulns);
      result.source = 'osv';
    } catch (e) {
      if (s.auditFallback && g.kind !== 'none') {
        try {
          result.hits = await runAudit(g.kind, path.dirname(lock!.file));
          result.source = 'audit';
          notes.push(`OSV.dev unreachable (${e}); used ${g.kind} audit instead`);
        } catch (e2) {
          notes.push(`vulnerability check failed: ${e2}`);
        }
      } else {
        notes.push(`vulnerability check failed: ${e}`);
      }
    }
  }

  // 3. registry (updates + deprecations)
  if (s.enableOutdated) {
    const names = [...new Set(entries.filter((e) => result.installed.has(e.name) && !SKIP_RANGE.test(e.range)).map((e) => e.name))];
    await pool(names, 8, async (n) => {
      const info = await fetchInfo(n, s.registry);
      if (info) result.info.set(n, info);
    });
  }
  return result;
}
