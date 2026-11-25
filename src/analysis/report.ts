// Editor-independent upgrade report shared by the VS Code extension and the JetBrains sidecar (server.ts). No `vscode` imports here.
import * as path from 'path';
import { compatFor } from './fixes';
import { auditOverrides } from './overrides';
import { bumpTargets } from '../versions/bump';
import { baseVersion, compare, parse } from '../versions/semver';
import { Bucket, BumpKind, CompatMap, CompatReport, DeprecatedRow, Finding, PackageManager, ReportRow, ScanResult, Section, Settings, UpgradeReport } from '../types';
import { OverrideAudit, OverrideRequest, OverrideRow } from '../types/overrides';

export const compatKey = (name: string, target: string) => `${name}@${target}`;

function bucketOf(installed: string, kind: BumpKind, compat?: CompatReport): Bucket {
  if (kind === 'major') return 'major';
  if (parse(installed)?.major === 0 && kind === 'minor') return 'caution';
  if (compat?.issues.some((i) => i.level !== 'info')) return 'caution';
  return 'safe';
}

/** Highest version that a vulnerability finding on `name` asks for, if any. */
function vulnFixVersion(findings: Finding[], name: string): string | undefined {
  let best: string | undefined;
  for (const f of findings) {
    if (f.kind !== 'vuln' || f.entry.name !== name) continue;
    for (const fx of f.fixes) {
      if (fx.type !== 'setVersion') continue;
      const v = baseVersion(fx.range);
      if (v && (!best || compare(v, best) > 0)) best = v;
    }
  }
  return best;
}

export function buildUpgradeReport(r: ScanResult, findings: Finding[], s: Settings, title = 'project', compat?: CompatMap, overrides?: OverrideAudit): UpgradeReport {
  const rows: ReportRow[] = [];
  const deprecated: DeprecatedRow[] = [];
  const notes: string[] = [];
  let unchecked = 0;

  if (!s.enableOutdated) notes.push('Update checks are disabled (pkgGuard.enableOutdated), so no upgrades were collected.');

  for (const e of s.enableOutdated ? r.entries : []) {
    if (s.ignoredPackages.includes(e.name)) continue;
    const installed = r.installed.get(e.name);
    const info = r.info.get(e.name);
    if (!installed || !info) {
      unchecked++;
      continue;
    }
    const dep = info.deprecated[installed];
    if (dep) deprecated.push({ name: e.name, installed, message: dep });
    const fix = vulnFixVersion(findings, e.name);
    const targets = bumpTargets(installed, info.versions);
    for (const kind of ['patch', 'minor', 'major'] as BumpKind[]) {
      const target = targets[kind];
      if (!target) continue;
      const c = compat?.get(compatKey(e.name, target));
      rows.push({
        name: e.name,
        section: e.section,
        range: e.range,
        installed,
        target,
        kind,
        bucket: bucketOf(installed, kind, c),
        fixesVuln: !!fix && compare(target, fix) >= 0,
        checked: !!c,
        notes: [
          ...(parse(installed)?.major === 0 && kind === 'minor' ? ['0.x minor releases may contain breaking changes'] : []),
          ...(c?.issues.filter((i) => i.level !== 'info').map((i) => i.text) ?? []),
        ],
      });
    }
  }

  if (unchecked) notes.push(`${unchecked} ${unchecked === 1 ? 'dependency was' : 'dependencies were'} not checked (not installed, not on the registry, or registry unavailable).`);
  if (rows.length && !compat) notes.push('Peer-dependency and Node-engine compatibility was not checked; "safe" only reflects the version numbers.');
  else if (rows.some((x) => !x.checked)) notes.push('Compatibility could not be verified for some upgrades; they are classified by version number only.');

  const count = (b: Bucket) => rows.filter((x) => x.bucket === b).length;
  return {
    title,
    pm: r.pm.name,
    rows,
    deprecated,
    summary: { safe: count('safe'), caution: count('caution'), major: count('major'), security: rows.filter((x) => x.fixesVuln).length, deprecated: deprecated.length },
    notes,
    ...(overrides?.rows.length ? { overrides } : {}),
  };
}

/** Run the peer / engines compatibility check for each candidate upgrade (network + node_modules); failures just leave that row unchecked. */
export async function collectCompat(text: string, pkgFile: string, r: ScanResult, s: Settings): Promise<CompatMap> {
  const base = buildUpgradeReport(r, [], s);
  const jobs = base.rows.filter((x) => x.kind !== 'major');
  const out: CompatMap = new Map();
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, jobs.length) }, async () => {
      while (i < jobs.length) {
        const j = jobs[i++];
        const info = r.info.get(j.name);
        if (!info) continue;
        try {
          out.set(compatKey(j.name, j.target), await compatFor({ text, pkgFile, name: j.name, target: j.target, info, registry: s.registry, trusted: s.trusted, installed: r.installed }));
        } catch {
          /* leave unchecked */
        }
      }
    }),
  );
  return out;
}

/** Scan result -> report with compatibility verified, plus its Markdown. */
export async function generateUpgradeReport(text: string, pkgFile: string, r: ScanResult, findings: Finding[], s: Settings) {
  let title = path.basename(path.dirname(pkgFile));
  try {
    title = JSON.parse(text).name ?? title;
  } catch {
    /* keep folder name */
  }
  const [compat, overrides] = await Promise.all([collectCompat(text, pkgFile, r, s), auditOverrides(text, pkgFile, r, s).catch(() => undefined)]);
  const report = buildUpgradeReport(r, findings, s, title, compat, overrides);
  return { report, markdown: formatUpgradeReport(report) };
}

const ADD: Record<PackageManager['name'], { cmd: string; dev: string; optional: string }> = {
  npm: { cmd: 'npm install', dev: '-D', optional: '-O' },
  yarn: { cmd: 'yarn add', dev: '-D', optional: '-O' },
  pnpm: { cmd: 'pnpm add', dev: '-D', optional: '-O' },
  bun: { cmd: 'bun add', dev: '-d', optional: '--optional' },
};

function installCommands(pm: PackageManager['name'], rows: ReportRow[]): string[] {
  const a = ADD[pm];
  const lines: string[] = [];
  for (const [section, flag] of [['dependencies', ''], ['devDependencies', ' ' + a.dev], ['optionalDependencies', ' ' + a.optional]] as [Section, string][]) {
    // a package can have several rows in one group (patch + minor); install the highest target once
    const best = new Map<string, string>();
    for (const x of rows) if (x.section === section && (!best.has(x.name) || compare(x.target, best.get(x.name)!) > 0)) best.set(x.name, x.target);
    const specs = [...best].map(([n, t]) => `${n}@${t}`);
    if (specs.length) lines.push(`${a.cmd}${flag} ${specs.join(' ')}`);
  }
  return lines;
}

function table(rows: ReportRow[]): string[] {
  const out = ['| Package | Current | Target | Type | Notes |', '| --- | --- | --- | --- | --- |'];
  for (const x of rows) {
    const notes = [...(x.fixesVuln ? ['🔒 fixes a known vulnerability'] : []), ...x.notes].join('; ').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    out.push(`| ${x.name} | ${x.installed} | ${x.target} | ${x.kind} | ${notes} |`);
  }
  return out;
}

const VERDICT: Record<OverrideRow['verdict'], string> = {
  'still-needed': '🔒 still needed',
  redundant: '🧹 no longer needed',
  'forces-other-major': '⚠️ forces another major',
  unused: 'unused',
  'not-checked': 'not checked',
};

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const requested = (q: OverrideRequest) => `${q.range} (${q.by.map((b) => b || 'package.json').join(', ')})`;
const wouldGet = (q: OverrideRequest) => `${requested(q)} would get ${q.fresh ?? 'no published version'}`;
const withAdvisories = (q: OverrideRequest) => `${wouldGet(q)}, which has ${q.advisories.join(', ')}`;

function overrideDetails(o: OverrideRow): string {
  const vulnerable = o.requests.filter((q) => q.advisories.length);
  const forced = o.requests.filter((q) => q.otherMajor);
  switch (o.verdict) {
    case 'still-needed': {
      const also = forced.length ? `; it also forces ${forced.map(requested).join(', ')} onto ${o.forced}` : '';
      return `without it, ${vulnerable.map(withAdvisories).join('; ')}${also}`;
    }
    case 'redundant': {
      const got = o.requests.filter((q) => q.fresh);
      return got.length ? `without it, ${got.map(wouldGet).join('; ')}, with no known Advisory; it can be removed` : `every request already asks for ${o.value}; it can be removed`;
    }
    case 'forces-other-major': {
      const clean = forced.filter((q) => !q.advisories.length);
      const need = vulnerable.length ? `; it is still needed because ${vulnerable.map(withAdvisories).join('; ')}: scope it to the packages that need it` : '';
      return `forces ${clean.map(requested).join(', ')} onto ${o.forced}; without it, they would get ${clean.map((q) => q.fresh).join(', ')}, with no known Advisory${need}`;
    }
    case 'unused':
      return o.key === o.name ? `nothing in the lockfile requests ${o.name}; it can be removed` : `${o.key.includes('/') || o.key.includes('>') ? 'the parent package' : 'the lockfile'} does not request ${o.name} as the key names it; it can be removed`;
    default:
      return o.reason ?? '';
  }
}

function overridesSection(a: OverrideAudit): string[] {
  const L = ['', '## 🧷 Overrides', '', `Each entry in \`${a.section}\`, compared with what the packages requesting it would get without it.`, '', '| Entry | Value | Verdict | Details |', '| --- | --- | --- | --- |'];
  for (const o of a.rows) L.push(`| ${cell(o.key)} | ${cell(o.value)} | ${VERDICT[o.verdict]} | ${cell(overrideDetails(o))} |`);
  if (a.lockfile === 'yarn-classic') L.push('', 'With yarn v1, removing a resolution leaves the old version locked until its lockfile entries are re-resolved: delete those entries from yarn.lock, then run `yarn install`.');
  return L;
}

export function formatUpgradeReport(r: UpgradeReport): string {
  const L: string[] = [`# Upgrade report: ${r.title}`, ''];
  const { safe, caution, major, security, deprecated } = r.summary;
  if (!r.rows.length && !r.deprecated.length) {
    L.push(r.notes.length ? '_No upgrades could be reported._' : '✅ Everything is up to date.');
  } else {
    L.push(`- ✅ **${safe}** safe to upgrade now (no breaking changes expected)`);
    L.push(`- ⚠️ **${caution}** need caution`);
    L.push(`- 🚨 **${major}** major, potentially breaking`);
    L.push(`- 🔒 **${security}** fix a known vulnerability`);
    L.push(`- 🗑️ **${deprecated}** deprecated ${deprecated === 1 ? 'package' : 'packages'} installed`);
  }

  const group = (title: string, blurb: string, rows: ReportRow[]) => {
    if (!rows.length) return;
    L.push('', `## ${title}`, '', blurb, '', ...table(rows), '', '```sh', ...installCommands(r.pm, rows), '```');
  };
  group('✅ Safe to upgrade now', 'Patch releases and minor releases of stable (1.0.0+) packages. Semver promises no breaking changes, and no peer or engine conflicts were found.', r.rows.filter((x) => x.bucket === 'safe'));
  group('⚠️ Review before upgrading', '0.x minor releases (which may break) and upgrades with peer-dependency or Node-engine problems.', r.rows.filter((x) => x.bucket === 'caution'));
  group('🚨 Major upgrades (potentially breaking)', 'A new major version. Read the changelog before applying.', r.rows.filter((x) => x.bucket === 'major'));

  if (r.overrides) L.push(...overridesSection(r.overrides));

  if (r.deprecated.length) {
    L.push('', '## 🗑️ Deprecated packages', '');
    for (const d of r.deprecated) L.push(`- **${d.name}@${d.installed}**: ${d.message.replace(/\n/g, ' ')}`);
  }
  if (r.notes.length) {
    L.push('', '## Notes', '');
    for (const n of r.notes) L.push(`- ${n}`);
  }
  return L.join('\n') + '\n';
}
