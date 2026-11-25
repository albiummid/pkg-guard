import * as fs from 'fs';
import * as path from 'path';
import { attribute, runAudit } from '../sources/audit';
import { buildBunGraph, buildNpmGraph, buildYarnGraph } from '../sources/lockfile';
import { buildPnpmGraph } from '../sources/pnpmLock';
import { osvQuery, Pkg } from '../sources/osv';
import { locateDeps } from '../manifest/packageJson';
import { fetchInfo } from '../sources/registry';
import { baseVersion } from '../versions/semver';
import { satisfies } from '../versions/satisfies';
import { detectPm } from '../manifest/packageManager';
import { Graph, LockKind } from '../types/index';
import { PackageManager, ScanResult, Settings } from '../types';

export const SKIP_RANGE = /^(workspace:|file:|link:|git|http|npm:|github:|portal:|patch:|catalog:)|\//;

/** Lockfile names in the order the package manager is detected (see detectPm), with the manager each belongs to. */
const LOCKFILES: { file: string; pm: PackageManager['name']; readable: LockKind | null }[] = [
  { file: 'pnpm-lock.yaml', pm: 'pnpm', readable: 'pnpm' },
  { file: 'yarn.lock', pm: 'yarn', readable: 'yarn' },
  { file: 'bun.lock', pm: 'bun', readable: 'bun' },
  { file: 'bun.lockb', pm: 'bun', readable: null },
  { file: 'package-lock.json', pm: 'npm', readable: 'npm' },
  { file: 'npm-shrinkwrap.json', pm: 'npm', readable: 'npm' },
];

const exists = (p: string): Promise<boolean> => fs.promises.access(p).then(() => true, () => false);

/** True at the last folder a parent walk looks at: the filesystem root, or `stopAt` when set (see ScanOptions). */
const lastFolder = (d: string, stopAt?: string): boolean => path.dirname(d) === d || (!!stopAt && path.resolve(d) === path.resolve(stopAt));

/** Seams for tests. */
export interface ScanOptions {
  /** The highest folder searched for lockfiles, node_modules and the package manager; unset searches up to the filesystem root. */
  stopAt?: string;
}

/** The nearest lockfile of any package manager. `kind` is null for the ones this tool cannot read. */
async function findLock(dir: string, stopAt?: string): Promise<{ file: string; kind: LockKind | null; pm: PackageManager['name'] } | null> {
  for (let d = dir; ; d = path.dirname(d)) {
    for (const l of LOCKFILES) {
      if (await exists(path.join(d, l.file))) return { file: path.join(d, l.file), kind: l.readable, pm: l.pm };
    }
    if (lastFolder(d, stopAt)) return null;
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

/** Same lookup as readInstalledPkg without blocking the host's thread; the scan reads one file per dependency. */
async function installedFromNodeModules(dir: string, name: string, stopAt?: string): Promise<string | undefined> {
  for (let d = dir; ; d = path.dirname(d)) {
    try {
      return JSON.parse(await fs.promises.readFile(path.join(d, 'node_modules', name, 'package.json'), 'utf8'))?.version;
    } catch {
      /* keep walking up */
    }
    if (lastFolder(d, stopAt)) return undefined;
  }
}

async function hasNodeModules(dir: string, stopAt?: string): Promise<boolean> {
  for (let d = dir; ; d = path.dirname(d)) {
    if (await exists(path.join(d, 'node_modules'))) return true;
    if (lastFolder(d, stopAt)) return false;
  }
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

export async function scan(text: string, pkgFile: string, s: Settings, opts: ScanOptions = {}): Promise<ScanResult> {
  const { stopAt } = opts;
  const notes: string[] = [];
  const entries = locateDeps(text);
  const result: ScanResult = { entries, installed: new Map(), hits: [], info: new Map(), lock: 'none', pm: detectPm(path.dirname(pkgFile), undefined, stopAt), source: 'none', notes };
  let pkg: any;
  try {
    pkg = JSON.parse(text);
  } catch {
    notes.push('package.json is not valid JSON yet');
    return result;
  }
  const dir = path.dirname(pkgFile);
  if (typeof pkg?.engines?.node === 'string') result.projectNode = pkg.engines.node;
  result.pm = detectPm(dir, pkg, stopAt);
  // A Pin goes to the workspace root manifest, so what that manifest declares decides whether a Pin is safe.
  if (result.pm.root) {
    const rootManifest = path.join(result.pm.root, 'package.json');
    if (path.resolve(rootManifest) !== path.resolve(pkgFile)) {
      try {
        const root = JSON.parse(await fs.promises.readFile(rootManifest, 'utf8'));
        result.rootDeclared = new Set([root.dependencies, root.devDependencies, root.optionalDependencies].flatMap((s) => Object.keys(s ?? {})));
      } catch {
        /* no readable root manifest: nothing extra to protect */
      }
    }
  }
  const rootDeps: Record<string, string> = {
    ...pkg.optionalDependencies,
    ...pkg.devDependencies,
    ...pkg.dependencies,
  };

  // dependencies that exist in the manifest but could not be located on one line cannot get Findings
  const located = new Set(entries.map((e) => e.name));
  const unlocated = Object.keys(rootDeps).filter((n) => !located.has(n));
  if (unlocated.length) notes.push(`${unlocated.length} ${unlocated.length === 1 ? 'dependency' : 'dependencies'} could not be located on a line of package.json and ${unlocated.length === 1 ? 'is' : 'are'} not checked: ${unlocated.join(', ')}`);

  // 1. resolve what is actually installed (lockfile > node_modules > range)
  let graph: Graph | null = null;
  const lock = await findLock(dir, stopAt);
  if (lock && lock.pm !== result.pm.name) {
    notes.push(`${path.basename(lock.file)} belongs to ${lock.pm}, not ${result.pm.name}; it was ignored and transitive vulnerability checks are off`);
  } else if (lock && !lock.kind) {
    notes.push(`${path.basename(lock.file)} is not supported yet (it is a binary file; "bun install --save-text-lockfile" writes a bun.lock); transitive vulnerability checks are off`);
  } else if (lock) {
    try {
      const text = await fs.promises.readFile(lock.file, 'utf8');
      // a workspace member resolves its own entry (yarn berry, pnpm importer) or nested copies (npm) before the root's
      const rel = path.relative(path.dirname(lock.file), dir).split(path.sep).join('/');
      const member = rel.startsWith('..') ? '' : rel;
      graph =
        lock.kind === 'yarn' ? buildYarnGraph(text, rootDeps, member)
        : lock.kind === 'pnpm' ? buildPnpmGraph(text, rootDeps, member || '.')
        : lock.kind === 'bun' ? buildBunGraph(text, rootDeps)
        : buildNpmGraph(JSON.parse(text), rootDeps, member);
    } catch (e) {
      notes.push(`could not read lockfile: ${e}`);
    }
    if (!graph) notes.push('lockfile format not supported (package-lock v1? a pnpm-lock.yaml with no lockfileVersion? bun.lock?); transitive checks disabled');
  }
  const g: Graph = graph ?? { kind: 'none', nodes: new Map(), roots: new Map() };
  result.lock = g.kind;
  result.copies = new Map();
  for (const n of g.nodes.values()) result.copies.set(n.name, [...(result.copies.get(n.name) ?? []), n.version]);
  const from = (result.installedFrom = new Map());
  const onDisk = (result.onDisk = new Map<string, string>());
  result.hasNodeModules = await hasNodeModules(dir, stopAt);
  // one read per dependency, all at once, instead of one blocking read after another
  const disks = await Promise.all(entries.map((e) => installedFromNodeModules(dir, e.name, stopAt)));
  /** Declared range of each dependency checked at its Floor version (nothing installed). */
  const floorRanges = new Map<string, string>();
  for (const [i, e] of entries.entries()) {
    const rid = g.roots.get(e.name);
    const locked = rid ? g.nodes.get(rid)?.version : undefined;
    const disk = disks[i];
    if (disk) onDisk.set(e.name, disk);
    const floor = SKIP_RANGE.test(e.range) ? undefined : baseVersion(e.range) ?? undefined;
    const v = locked || disk || floor;
    if (v) {
      result.installed.set(e.name, v);
      from.set(e.name, locked ? 'lock' : disk ? 'node_modules' : 'floor');
    }
    if (!rid && v) {
      // no lockfile: synthesize a root node so the vulnerability lookup still works
      const id = `${e.name}@${v}`;
      if (!disk) floorRanges.set(e.name, e.range);
      g.nodes.set(id, { id, name: e.name, version: v, deps: [] });
      g.roots.set(e.name, id);
    }
  }

  const unknown = entries.filter((e) => !result.installed.has(e.name) && !SKIP_RANGE.test(e.range)).map((e) => e.name);
  if (unknown.length) notes.push(`no version is known for ${unknown.length} ${unknown.length === 1 ? 'dependency' : 'dependencies'} (a tag, a union or another range with no lowest version, and nothing installed), so ${unknown.length === 1 ? 'it was' : 'they were'} not checked: ${unknown.join(', ')}`);

  // 2. registry (updates + deprecations, and the versions a range allows when nothing is installed)
  if (s.enableOutdated) {
    const names = [...new Set(entries.filter((e) => result.installed.has(e.name) && !SKIP_RANGE.test(e.range)).map((e) => e.name))];
    await pool(names, 8, async (n) => {
      const info = await fetchInfo(n, s.registry, { dir: path.dirname(pkgFile), trusted: s.trusted });
      if (info) result.info.set(n, info);
    });
  }

  // 3. vulnerabilities
  if (s.enableVulnerabilities) {
    try {
      let nodes: Pkg[] = [...g.nodes.values()];
      if (!s.checkTransitive || g.kind === 'none') nodes = [...g.roots.values()].map((id) => g.nodes.get(id)!);
      // Nothing installed: every Allowed version is checked, not only the Floor version. Those come from the registry data fetched
      // above for available Updates; without it (update checks off, no registry data) only the Floor version is, as a plain query.
      const floorOnly = new Map<string, string[]>();
      nodes = nodes.map((n) => {
        const range = floorRanges.get(n.name);
        if (!range || g.roots.get(n.name) !== `${n.name}@${n.version}`) return n;
        const info = result.info.get(n.name);
        const allowed = (info?.versions ?? []).filter((v) => satisfies(v, range));
        if (allowed.length) return { ...n, allowed };
        const why = !s.enableOutdated ? 'update checks are off' : !info ? 'no registry data' : 'the registry lists no version the range allows';
        floorOnly.set(why, [...(floorOnly.get(why) ?? []), n.name]);
        return n;
      });
      const vulns = await osvQuery(nodes);
      result.hits = attribute(g, vulns);
      result.source = 'osv';
      for (const [why, names] of floorOnly) {
        const one = names.length === 1;
        notes.push(`only the lowest version of the range was checked for ${names.length} ${one ? 'dependency' : 'dependencies'} with nothing installed (${why}); later versions ${one ? 'its range allows' : 'their ranges allow'} were not checked: ${names.join(', ')}`);
      }
    } catch (e) {
      if (s.auditFallback && (g.kind === 'yarn' || g.kind === 'npm')) {
        try {
          // runAudit only returns a complete report; anything else throws, so a failed audit is never taken for "no vulnerabilities"
          result.hits = await runAudit(g.kind, path.dirname(lock!.file));
          result.source = 'audit';
          notes.push(`OSV.dev unreachable (${e}); used ${g.kind} audit instead`);
        } catch (e2) {
          notes.push(`vulnerability check failed: OSV.dev unreachable (${e}) and the ${g.kind} audit failed too (${e2})`);
        }
      } else {
        notes.push(`vulnerability check failed: ${e}`);
      }
    }
  }
  return result;
}
