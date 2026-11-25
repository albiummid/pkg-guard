// Editor-independent operations shared by the VS Code extension and the JetBrains sidecar (server.ts). No `vscode` imports here.
import * as fs from 'fs';
import * as path from 'path';
import { checkCompat, findCompanion } from './compat';
import { addToSection, locateDeps } from '../manifest/packageJson';
import { detectPm } from '../manifest/packageManager';
import { fetchInfo } from '../sources/registry';
import { satisfies } from '../versions/satisfies';
import { readInstalledPkg } from './scan';
import { baseVersion, gt, isStable, prefixOf } from '../versions/semver';
import { CompatContext, CompatReport, DepEntry, Dependent, Fix, FixEffect, PinRequest, RangeUpdate, RegistryInfo, TextEdit } from '../types';

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

/**
 * The manifest a Pin must be written to. yarn `resolutions`, npm `overrides` and pnpm `pnpm.overrides` only take effect in the
 * workspace root's package.json, so a Pin found while scanning a workspace member goes there. Undefined = the scanned manifest.
 */
export function pinTarget(pkgFile: string | undefined): string | undefined {
  if (!pkgFile) return undefined;
  const root = detectPm(path.dirname(pkgFile)).root;
  if (!root) return undefined;
  const manifest = path.join(root, 'package.json');
  return path.resolve(manifest) !== path.resolve(pkgFile) && fs.existsSync(manifest) ? manifest : undefined;
}

/** What applying a finding's fix means: text edits for package.json, or an ignore-list entry for the host's settings. */
export function fixEffect(text: string, entry: DepEntry, fx: Fix, pkgFile?: string): FixEffect {
  switch (fx.type) {
    case 'setVersion':
      return { type: 'edit', edits: [{ startLine: entry.line, startChar: entry.versionStart, endLine: entry.line, endChar: entry.versionEnd, newText: fx.range }] };
    case 'addOverride': {
      const file = pinTarget(pkgFile);
      const source = file ? fs.readFileSync(file, 'utf8') : text;
      const edits = [replaceAll(source, addToSection(source, fx.section, fx.name, fx.range))];
      return file ? { type: 'edit', edits, file } : { type: 'edit', edits };
    }
    case 'ignoreAdvisory':
      return { type: 'setting', key: 'ignoredAdvisories', value: fx.id };
    case 'ignorePackage':
      return { type: 'setting', key: 'ignoredPackages', value: fx.name };
    case 'install':
      return { type: 'install' };
  }
}

/** Writes several Pins at once: one whole-document edit of the manifest the Pins belong to (`file` when that is not the scanned one). */
export function pinsEffect(text: string, pins: PinRequest[], pkgFile?: string): FixEffect {
  const file = pinTarget(pkgFile);
  const source = file ? fs.readFileSync(file, 'utf8') : text;
  const out = pins.reduce((t, p) => addToSection(t, p.section, p.name, p.range), source);
  const edits = [replaceAll(source, out)];
  return file ? { type: 'edit', edits, file } : { type: 'edit', edits };
}

/** Without node_modules: the installed version's manifest from the scan's registry data (lockfile version). */
function scannedManifest(c: CompatContext, name: string) {
  const v = c.installed?.get(name);
  const m = v ? c.infos?.get(name)?.manifests[v] : undefined;
  return m && { ...m, version: v };
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
    const m = readInstalledPkg(dir, e.name) ?? scannedManifest(c, e.name);
    const range: string | undefined = m?.peerDependencies?.[c.name];
    if (!m || range === undefined) continue;
    const dep: Dependent = { name: e.name, version: m.version, peerRange: range, optional: !!m.peerDependenciesMeta?.[c.name]?.optional };
    if (!satisfies(c.target, range)) {
      const depInfo = c.infos?.get(e.name) ?? (await fetchInfo(e.name, c.registry, { dir: path.dirname(c.pkgFile), trusted: c.trusted }));
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

