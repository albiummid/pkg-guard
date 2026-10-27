// Editor-independent operations shared by the VS Code extension and the JetBrains sidecar (server.ts). No `vscode` imports here.
import * as path from 'path';
import { CompatReport, Dependent, checkCompat, findCompanion } from '../updates/compat';
import { Finding, Fix } from '../scan/findings';
import { DepEntry, Section, addToSection, locateDeps } from '../manifest/packageJson';
import { RegistryInfo, fetchInfo } from '../updates/registry';
import { satisfies } from '../utils/satisfies';
import { readInstalledPkg } from '../scan/scan';
import { baseVersion, gt, isStable, prefixOf } from '../utils/semver';

/** A text replacement; 0-based line / column, end exclusive. */
export interface TextEdit {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  newText: string;
}

export interface RangeUpdate {
  name: string;
  version: string;
  section?: Section;
}

export function latestStable(info: RegistryInfo): string | undefined {
  let best = info.latest && isStable(info.latest) ? info.latest : undefined;
  for (const v of info.versions) if (isStable(v) && (!best || gt(v, best))) best = v;
  return best;
}

/** Edits that rewrite dependency ranges in package.json (keeps the ^ / ~ style). Empty when nothing matched. */
export function rangeEdits(text: string, updates: RangeUpdate[]): TextEdit[] {
  const entries = locateDeps(text);
  const edits: TextEdit[] = [];
  for (const u of updates) {
    const matches = entries.filter((e) => e.name === u.name && (!u.section || e.section === u.section));
    for (const e of matches.slice(0, u.section ? 1 : matches.length)) {
      const prefix = baseVersion(e.range) ? prefixOf(e.range) : '^';
      edits.push({ startLine: e.line, startChar: e.versionStart, endLine: e.line, endChar: e.versionEnd, newText: prefix + u.version });
    }
  }
  return edits;
}

/** Whole-document replacement, for edits that re-serialise the JSON. */
export function replaceAll(text: string, newText: string): TextEdit {
  const lines = text.split('\n');
  return { startLine: 0, startChar: 0, endLine: lines.length - 1, endChar: lines[lines.length - 1].length, newText };
}

export type FixEffect =
  | { type: 'edit'; edits: TextEdit[] }
  | { type: 'setting'; key: 'ignoredAdvisories' | 'ignoredPackages'; value: string };

/** What applying a finding's fix means: text edits for package.json, or an ignore-list entry for the host's settings. */
export function fixEffect(text: string, entry: DepEntry, fx: Fix): FixEffect {
  switch (fx.type) {
    case 'setVersion':
      return { type: 'edit', edits: [{ startLine: entry.line, startChar: entry.versionStart, endLine: entry.line, endChar: entry.versionEnd, newText: fx.range }] };
    case 'addOverride':
      return { type: 'edit', edits: [replaceAll(text, addToSection(text, fx.section, fx.name, fx.range))] };
    case 'ignoreAdvisory':
      return { type: 'setting', key: 'ignoredAdvisories', value: fx.id };
    case 'ignorePackage':
      return { type: 'setting', key: 'ignoredPackages', value: fx.name };
  }
}

export interface CompatContext {
  /** package.json text and path of the project that owns the dependency */
  text: string;
  pkgFile: string;
  name: string;
  target: string;
  info: RegistryInfo;
  registry: string;
  /** installed versions from the last scan; node_modules is the fallback */
  installed?: Map<string, string>;
}

/** What else changes if `name` goes from its installed version to `target`. */
export async function compatFor(c: CompatContext): Promise<CompatReport> {
  const dir = path.dirname(c.pkgFile);
  const installed = c.installed?.get(c.name);
  const pkg = JSON.parse(c.text);
  const installedOf = (d: string): string | undefined => c.installed?.get(d) ?? readInstalledPkg(dir, d)?.version;

  // installed packages that peer on this one: read their manifests from node_modules, ask the registry only for the ones that would break
  const dependents: Dependent[] = [];
  for (const e of locateDeps(c.text)) {
    if (e.name === c.name) continue;
    const m = readInstalledPkg(dir, e.name);
    const range: string | undefined = m?.peerDependencies?.[c.name];
    if (!m || range === undefined) continue;
    const dep: Dependent = { name: e.name, version: m.version, peerRange: range, optional: !!m.peerDependenciesMeta?.[c.name]?.optional };
    if (!satisfies(c.target, range)) {
      const depInfo = await fetchInfo(e.name, c.registry);
      if (depInfo) dep.fixedBy = findCompanion(depInfo.versions, depInfo.manifests, c.name, c.target, m.version);
    }
    dependents.push(dep);
  }
  return checkCompat({
    name: c.name,
    installed,
    target: c.target,
    current: installed ? c.info.manifests[installed] : undefined,
    next: c.info.manifests[c.target],
    installedOf,
    projectNode: pkg.engines?.node,
    dependents,
  });
}

export type { Finding };
