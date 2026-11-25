// Editor-independent upgrade report shared by the VS Code extension and the JetBrains sidecar (server.ts). No `vscode` imports here.
import * as path from 'path';
import { compatFor } from './fixes';
import { reportedHits } from './findings';
import { bumpTargets } from '../versions/bump';
import { baseVersion, compare, major, parse } from '../versions/semver';
import { isRange, satisfies } from '../versions/satisfies';
import { Bucket, BumpKind, CompatMap, CompatReport, DeprecatedRow, Finding, Hit, Issue, PackageManager, ReportRow, SEVERITY_RANK, ScanResult, Section, Settings, UncheckedDep, UpgradeReport, VulnRow } from '../types';

export const compatKey = (name: string, target: string) => `${name}@${target}`;

function bucketOf(installed: string, kind: BumpKind, compat?: CompatReport): Bucket {
  if (kind === 'major') return 'major';
  if (parse(installed)?.major === 0 && kind === 'minor') return 'caution';
  if (compat?.issues.some((i) => i.level !== 'info')) return 'caution';
  return 'safe';
}

const RANK: Record<Bucket, number> = { safe: 0, caution: 1, major: 2 };

/**
 * Another row, in the same or a safer bucket, that resolves `issue` of row `x`: its target meets the peer `x` needs,
 * or it is the dependent whose peer range rejects `x`'s target and its new version accepts that target.
 */
function partnerOf(x: ReportRow, issue: Issue, rows: ReportRow[], r: ScanResult, c: CompatReport): ReportRow | undefined {
  const fits = (y: ReportRow): boolean => {
    if (y.name === x.name || RANK[y.bucket] > RANK[x.bucket]) return false;
    if (issue.peer) return y.name === issue.peer.name && satisfies(y.target, issue.peer.range);
    if (issue.dependent?.name !== y.name) return false;
    const m = r.info.get(y.name)?.manifests[y.target];
    if (!m) return c.companions.some((k) => k.name === y.name && k.to === y.target);
    const range = m.peerDependencies?.[x.name];
    return range === undefined || (isRange(range) && satisfies(x.target, range));
  };
  return rows.filter(fits).sort((a, b) => RANK[a.bucket] - RANK[b.bucket] || compare(a.target, b.target))[0];
}

/**
 * Judges each row's Compatibility issues against the whole report: an issue another row's upgrade resolves becomes
 * "upgrade together with name@target" (majors just drop it) and no longer counts toward caution; a pair lands in the
 * bucket of its riskier member. Major rows keep their bucket and list what blocks them; already-the-case info is shown on the others.
 */
function upgradeTogether(rows: ReportRow[], compatOf: Map<ReportRow, CompatReport>, r: ScanResult) {
  const partners = new Map<ReportRow, ReportRow[]>();
  const decided = new Map<ReportRow, { bucket: Bucket; notes: string[] }>();
  for (const [x, c] of compatOf) {
    const notes = [...x.notes];
    let blocked = notes.length > 0; // the 0.x minor note
    const with_: ReportRow[] = [];
    for (const issue of c.issues) {
      if (issue.level === 'info') {
        if (issue.alreadyTheCase && x.kind !== 'major') notes.push(issue.text);
        continue;
      }
      const p = issue.peer || issue.dependent ? partnerOf(x, issue, rows, r, c) : undefined;
      if (!p) {
        blocked = true;
        notes.push(issue.text);
      } else if (!with_.includes(p)) {
        with_.push(p);
        if (x.kind !== 'major') notes.push(`upgrade together with ${p.name}@${p.target}`);
      }
    }
    partners.set(x, with_);
    decided.set(x, { bucket: x.kind === 'major' ? 'major' : blocked ? 'caution' : 'safe', notes });
  }
  for (const [x, d] of decided) Object.assign(x, d);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [x, with_] of partners) {
      for (const p of with_) {
        if (RANK[p.bucket] > RANK[x.bucket]) {
          x.bucket = p.bucket;
          changed = true;
        }
      }
    }
  }
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

/** `@types/node` describing a newer Node than the lowest major `engines.node` allows: a non-major row moves to caution, a major row keeps its bucket. */
function checkNodeTypes(row: ReportRow, projectNode: string | undefined): void {
  if (row.name !== '@types/node' || !projectNode) return;
  const base = baseVersion(projectNode);
  const n = base ? major(base) : null;
  const target = major(row.target);
  if (n === null || target === null || target <= n) return;
  row.notes.push(`@types/node ${target} describes Node ${target}, but the project's engines.node is ${projectNode}`);
  if (row.kind !== 'major') row.bucket = 'caution';
}

/**
 * One row per package per bucket: the minor row already includes the patch, so the patch row only stays when it lands in a
 * different bucket, or when it fixes a Vulnerability the minor row is not known to fix (the minor's own range may not reach the fix).
 */
const dedupe = (rows: ReportRow[]) =>
  rows.filter(
    (x) =>
      x.kind !== 'patch' ||
      !rows.some((y) => y.name === x.name && y.kind === 'minor' && y.bucket === x.bucket && (!x.fixesVuln || y.fixesVuln) && x.fixes.every((k) => y.fixes.includes(k))),
  );

/** Lowest version a range allows, for the simple forms ("^1.2.3", ">=1.2.3 <2", "^1 || ^2"); null when it can't be told. */
function lowestOf(range: string): string | null {
  let lo: string | null = null;
  for (const alt of range.split('||')) {
    const v = baseVersion(alt.trim().split(/\s+/)[0] ?? '');
    if (!v) return null;
    if (!lo || compare(v, lo) < 0) lo = v;
  }
  return lo;
}

interface VulnGroup {
  row: VulnRow;
  hits: Hit[];
}

/** One group per affected package@version, from the hits the Findings report. */
function vulnGroups(r: ScanResult, s: Settings): Map<string, VulnGroup> {
  const groups = new Map<string, VulnGroup>();
  for (const h of reportedHits(r, s)) {
    const key = `${h.vuln.pkg}@${h.vuln.version}`;
    let g = groups.get(key);
    if (!g) {
      g = { row: { name: h.vuln.pkg, version: h.vuln.version, direct: false, parents: [], severity: h.vuln.severity, advisories: [], fixes: [] }, hits: [] };
      groups.set(key, g);
    }
    g.hits.push(h);
    const x = g.row;
    if (h.path.length === 1) x.direct = true;
    if (!x.parents.includes(h.root)) x.parents.push(h.root);
    if (!x.advisories.includes(h.vuln.id)) x.advisories.push(h.vuln.id);
    if (SEVERITY_RANK[h.vuln.severity] > SEVERITY_RANK[x.severity]) x.severity = h.vuln.severity;
    if (h.vuln.fixedIn && (!x.fixedIn || compare(h.vuln.fixedIn, x.fixedIn) > 0)) x.fixedIn = h.vuln.fixedIn;
  }
  for (const { row } of groups.values()) {
    row.parents.sort();
    row.advisories.sort();
  }
  return groups;
}

/**
 * The Vulnerability rows an upgrade of `name` to `target` fixes. A Transitive vulnerability counts only when the vulnerable package
 * is a direct child of `name` on its path and the lowest version of the target's own range for it reaches the fixed version.
 */
function fixedBy(name: string, target: string, r: ScanResult, groups: Map<string, VulnGroup>, directFix: boolean): string[] {
  const deps = r.info.get(name)?.manifests[target]?.dependencies;
  const out: string[] = [];
  for (const [key, g] of groups) {
    const mine = g.hits.filter((h) => h.root === name);
    if (!mine.length) continue;
    if (mine.some((h) => h.path.length === 1)) {
      if (directFix) out.push(key);
      continue;
    }
    const range = g.row.fixedIn && mine.some((h) => h.path.length === 2) ? deps?.[g.row.name] : undefined;
    const lo = range ? lowestOf(range) : null;
    if (lo && g.row.fixedIn && compare(lo, g.row.fixedIn) >= 0) out.push(key);
  }
  return out;
}

const fixTitle = (t: string) => t.replace(/ \(fixes .*\)$/, '');

/** Fill in each Vulnerability row's Fixes: the Update or Pin its Findings offer, the upgrades that fix it, or why there is none. */
function describeFixes(r: ScanResult, findings: Finding[], groups: Map<string, VulnGroup>, rows: ReportRow[]) {
  for (const [key, { row: x, hits }] of groups) {
    const fixes = new Set<string>();
    for (const f of findings) {
      for (const fx of f.fixes) {
        if (x.direct && f.kind === 'vuln' && f.entry.name === x.name && fx.type === 'setVersion') fixes.add(fixTitle(fx.title));
        if (!x.direct && f.kind === 'transitive' && fx.type === 'addOverride' && fx.name === x.name && fx.range === `^${x.fixedIn}`) fixes.add(fixTitle(fx.title));
      }
    }
    const pinned = fixes.size > 0 && !x.direct;
    // per direct dependency, the smallest upgrade that fixes it
    const best = new Map<string, string>();
    for (const row of rows) {
      if (row.name === x.name || !row.fixes.includes(key)) continue;
      const t = best.get(row.name);
      if (!t || compare(row.target, t) < 0) best.set(row.name, row.target);
    }
    for (const [n, t] of best) fixes.add(`Update ${n} to ${t}`);
    x.fixes = [...fixes];
    if (x.direct) {
      if (!x.fixes.length) x.noFix = x.fixedIn ? 'no published version reaches the fixed version' : 'no fixed version known';
      continue;
    }
    if (pinned) continue;
    const others = (r.copies?.get(x.name) ?? []).filter((v) => v !== x.version);
    const fixedMajor = x.fixedIn ? major(x.fixedIn) : null;
    const why = !x.fixedIn
      ? 'no fixed version known'
      : r.entries.some((e) => e.name === x.name) || r.rootDeclared?.has(x.name)
        ? `${x.name} is also a direct dependency; update it there`
        : others.some((v) => major(v) !== fixedMajor)
          ? `no Pin: a global one would force copies in several majors (${[x.version, ...others].sort(compare).join(', ')}) onto one`
          : 'no Pin offered';
    if (!x.fixes.length) x.noFix = why;
    if (r.pm.name === 'yarn' && x.fixedIn) {
      const requesters = [...new Set(hits.map((h) => h.path[h.path.length - 2]))].sort();
      x.hint = `scope a resolution to the parent, e.g. ${requesters.map((p) => `"**/${p}/${x.name}": "^${x.fixedIn}"`).join(', ')}`;
    }
  }
}

export function buildUpgradeReport(r: ScanResult, findings: Finding[], s: Settings, title = 'project', compat?: CompatMap): UpgradeReport {
  const rows: ReportRow[] = [];
  const deprecated: DeprecatedRow[] = [];
  const notes: string[] = [];
  const compatOf = new Map<ReportRow, CompatReport>();
  const unchecked: UncheckedDep[] = [];
  const groups = vulnGroups(r, s);

  if (!s.enableOutdated) notes.push('Update checks are disabled (pkgGuard.enableOutdated), so no upgrades were collected.');

  for (const e of s.enableOutdated ? r.entries : []) {
    if (s.ignoredPackages.includes(e.name)) continue;
    const installed = r.installed.get(e.name);
    const info = r.info.get(e.name);
    if (!installed || !info) {
      unchecked.push({ name: e.name, reason: installed ? 'registry lookup failed' : 'not installed' });
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
      const directFix = !!fix && compare(target, fix) >= 0;
      const fixes = fixedBy(e.name, target, r, groups, directFix);
      const row: ReportRow = {
        name: e.name,
        section: e.section,
        range: e.range,
        installed,
        target,
        kind,
        bucket: bucketOf(installed, kind, c),
        fixesVuln: directFix || fixes.length > 0,
        fixes,
        checked: !!c,
        notes: parse(installed)?.major === 0 && kind === 'minor' ? ['0.x minor releases may contain breaking changes'] : [],
      };
      rows.push(row);
      if (c) compatOf.set(row, c);
    }
  }
  // the @types/node note blocks like any other note; patch rows are folded only once the final buckets are known
  for (const x of rows) checkNodeTypes(x, r.projectNode);
  upgradeTogether(rows, compatOf, r);

  for (const [reason, why] of [['registry lookup failed', 'the registry lookup failed'], ['not installed', 'it is not installed']] as const) {
    const names = unchecked.filter((u) => u.reason === reason).map((u) => u.name);
    if (names.length) notes.push(`${names.length} ${names.length === 1 ? 'dependency was' : 'dependencies were'} not checked because ${why}: ${names.join(', ')}`);
  }
  if (rows.length && !compat) notes.push('Peer-dependency and Node-engine compatibility was not checked; "safe" only reflects the version numbers.');
  else if (rows.some((x) => !x.checked)) notes.push('Compatibility could not be verified for some upgrades; they are classified by version number only.');

  notes.push(...r.notes);

  // the Vulnerability rows name, and the summary counts, only the upgrades that survive the fold
  const kept = dedupe(rows);
  describeFixes(r, findings, groups, kept);
  const vulns = [...groups.values()].map((g) => g.row).sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.name.localeCompare(b.name) || compare(a.version, b.version));
  const known = (direct: boolean) => vulns.filter((v) => v.direct === direct).reduce((n, v) => n + v.advisories.length, 0);
  const count = (b: Bucket) => kept.filter((x) => x.bucket === b).length;
  return {
    title,
    pm: r.pm.name,
    rows: kept,
    vulns,
    deprecated,
    summary: {
      safe: count('safe'),
      caution: count('caution'),
      major: count('major'),
      security: kept.filter((x) => x.fixesVuln).length,
      deprecated: deprecated.length,
      vulnerabilities: { direct: known(true), transitive: known(false) },
    },
    notes,
    unchecked,
  };
}

/** Every upgrade the report could show, before patch rows are folded into minor rows (which ones survive depends on the check). */
function candidates(r: ScanResult, s: Settings): { name: string; kind: BumpKind; target: string }[] {
  if (!s.enableOutdated) return [];
  return r.entries.flatMap((e) => {
    const installed = r.installed.get(e.name);
    const info = r.info.get(e.name);
    if (s.ignoredPackages.includes(e.name) || !installed || !info) return [];
    const targets = bumpTargets(installed, info.versions);
    return (['patch', 'minor', 'major'] as BumpKind[]).flatMap((kind) => (targets[kind] ? [{ name: e.name, kind, target: targets[kind]! }] : []));
  });
}

/** Run the peer / engines compatibility check for each candidate upgrade (network + node_modules); failures just leave that row unchecked. */
export async function collectCompat(text: string, pkgFile: string, r: ScanResult, s: Settings): Promise<CompatMap> {
  const jobs = candidates(r, s);
  const out: CompatMap = new Map();
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, jobs.length) }, async () => {
      while (i < jobs.length) {
        const j = jobs[i++];
        const info = r.info.get(j.name);
        if (!info) continue;
        try {
          out.set(compatKey(j.name, j.target), await compatFor({ text, pkgFile, name: j.name, target: j.target, info, registry: s.registry, trusted: s.trusted, installed: r.installed, infos: r.info }));
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
  const report = buildUpgradeReport(r, findings, s, title, await collectCompat(text, pkgFile, r, s));
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
    const notes = [...(x.fixesVuln ? [x.fixes.length ? `🔒 fixes ${x.fixes.join(', ')}` : '🔒 fixes a known vulnerability'] : []), ...x.notes].join('; ').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    out.push(`| ${x.name} | ${x.installed} | ${x.target} | ${x.kind} | ${notes} |`);
  }
  return out;
}

export function formatUpgradeReport(r: UpgradeReport): string {
  const L: string[] = [`# Upgrade report: ${r.title}`, ''];
  const { safe, caution, major, security, deprecated, vulnerabilities } = r.summary;
  if (!r.rows.length && !r.deprecated.length && !r.vulns.length) {
    L.push(r.notes.length ? '_No upgrades could be reported._' : '✅ Everything is up to date.');
  } else {
    L.push(`- ✅ **${safe}** safe to upgrade now (no breaking changes expected)`);
    L.push(`- ⚠️ **${caution}** need caution`);
    L.push(`- 🚨 **${major}** major, potentially breaking`);
    const known = vulnerabilities.direct + vulnerabilities.transitive;
    L.push(`- 🛡️ **${known}** known ${known === 1 ? 'vulnerability' : 'vulnerabilities'} (${vulnerabilities.direct} direct, ${vulnerabilities.transitive} transitive)`);
    L.push(`- 🔒 **${security}** ${security === 1 ? 'upgrade fixes' : 'upgrades fix'} a known vulnerability`);
    L.push(`- 🗑️ **${deprecated}** deprecated ${deprecated === 1 ? 'package' : 'packages'} installed`);
  }

  if (r.vulns.length) {
    L.push('', '## 🛡️ Vulnerabilities', '', 'Every Vulnerability the scan found, one row per affected package version, with the direct dependencies that pull it in.', '');
    L.push('| Package | Severity | Advisories | Pulled in by | Fixed in | Fix |', '| --- | --- | --- | --- | --- | --- |');
    for (const v of r.vulns) {
      const fix = [...(v.fixes.length ? v.fixes : [`none: ${v.noFix}`]), ...(v.hint ? [`yarn: ${v.hint}`] : [])].join('; ').replace(/\|/g, '\\|');
      L.push(`| ${v.name}@${v.version} | ${v.severity} | ${v.advisories.join(', ')} | ${v.direct ? 'direct' : v.parents.join(', ')} | ${v.fixedIn ?? '–'} | ${fix} |`);
    }
  }

  const group = (title: string, blurb: string, rows: ReportRow[]) => {
    if (!rows.length) return;
    L.push('', `## ${title}`, '', blurb, '', ...table(rows), '', '```sh', ...installCommands(r.pm, rows), '```');
  };
  group('✅ Safe to upgrade now', 'Patch releases and minor releases of stable (1.0.0+) packages. Semver promises no breaking changes, and no peer or engine conflicts were found.', r.rows.filter((x) => x.bucket === 'safe'));
  group('⚠️ Review before upgrading', '0.x minor releases (which may break) and upgrades with peer-dependency or Node-engine problems.', r.rows.filter((x) => x.bucket === 'caution'));
  group('🚨 Major upgrades (potentially breaking)', 'A new major version. Read the changelog before applying.', r.rows.filter((x) => x.bucket === 'major'));

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
