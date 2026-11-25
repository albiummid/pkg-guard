import { pickAtLeast, suggest } from '../sources/registry';
import { SKIP_RANGE } from './scan';
import { satisfies } from '../versions/satisfies';
import { baseVersion, compare, diffKind, gt, isTagRange, major, prefixOf } from '../versions/semver';
import { Hit, SEVERITY_RANK, Severity, Vuln } from '../types/index';
import { Finding, Fix, ScanResult, Settings } from '../types';

const LABEL: Record<Severity, string> = { critical: 'CRITICAL', high: 'HIGH', moderate: 'MODERATE', low: 'LOW', unknown: 'UNKNOWN' };

function top(vs: Vuln[]): Vuln {
  return vs.reduce((a, b) => (SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a));
}

function breakdown(vs: Vuln[]): string {
  const c = new Map<Severity, number>();
  for (const v of vs) c.set(v.severity, (c.get(v.severity) ?? 0) + 1);
  return (['critical', 'high', 'moderate', 'low', 'unknown'] as Severity[])
    .filter((k) => c.has(k))
    .map((k) => `${c.get(k)} ${k}`)
    .join(', ');
}

function diagLevel(s: Severity): Finding['level'] {
  return s === 'critical' || s === 'high' ? 'error' : s === 'low' ? 'info' : 'warning';
}

function maxFixed(vs: Vuln[]): string | undefined {
  let m: string | undefined;
  for (const v of vs) if (v.fixedIn && (!m || gt(v.fixedIn, m))) m = v.fixedIn;
  return m;
}

function advisoryLines(vs: Vuln[]): string {
  const sorted = [...vs].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const lines = sorted.slice(0, 6).map((v) => `• ${LABEL[v.severity]} ${v.id}: ${v.summary}`);
  if (sorted.length > 6) lines.push(`• …and ${sorted.length - 6} more`);
  return lines.join('\n');
}

/** The affected Allowed versions of a dependency checked with nothing installed, oldest first ("1.0.1, 1.0.2 and 3 more"). */
function versionList(vs: Vuln[]): string {
  const all = [...new Set(vs.flatMap((v) => v.affectedAllowed ?? []))].sort(compare);
  return all.length > 4 ? `${all.slice(0, 4).join(', ')} and ${all.length - 4} more` : all.join(', ');
}

/** "p may be vulnerable (…)" for a dependency with nothing installed; names the affected Allowed versions when they were checked and are known. */
function guessedLead(name: string, range: string, installed: string | undefined, vs: Vuln[]): string {
  // only the Floor version was checked (Allowed versions not known): the version is the one guessed
  if (!vs.some((v) => v.affectedAllowed)) return `${name}@${installed ?? '?'} may be vulnerable (version guessed from ${range})`;
  const list = versionList(vs);
  return `${name} may be vulnerable (version guessed from ${range}${list ? `, which allows affected ${list}` : ''})`;
}

/** The hits the Findings report: those at or above the minimum Severity whose Advisory is not ignored. */
export function reportedHits(r: ScanResult, s: Settings): Hit[] {
  const reported = reportable(s);
  return r.hits.filter((h) => reported(h.vuln));
}

/** Whether an Advisory passes the minimum Severity and is not ignored (by id or alias). */
export function reportable(s: Settings): (v: Vuln) => boolean {
  const minRank = SEVERITY_RANK[s.minSeverity];
  const ignored = new Set(s.ignoredAdvisories);
  // an advisory with no rating is never filtered out by the minimum: hiding what nobody has rated would hide malware records too
  return (v) => (v.severity === 'unknown' || SEVERITY_RANK[v.severity] >= minRank) && !ignored.has(v.id) && !v.aliases?.some((a) => ignored.has(a));
}

export function buildFindings(r: ScanResult, s: Settings): Finding[] {
  const out: Finding[] = [];
  const hits = reportedHits(r, s);
  const overrideSection = r.pm.overrideSection;

  for (const e of r.entries) {
    const installed = r.installed.get(e.name);
    const info = r.info.get(e.name);
    const prefix = prefixOf(e.range);
    const mine = hits.filter((h) => h.root === e.name);

    // --- vulnerabilities in the dependency itself
    const direct = mine.filter((h) => h.path.length === 1).map((h) => h.vuln);
    let appliedTarget: string | undefined;
    if (direct.length) {
      const worst = top(direct);
      const need = maxFixed(direct);
      const target = need ? pickAtLeast(need, installed ?? need, info ?? null) : undefined;
      const fixes: Fix[] = [];
      appliedTarget = target;
      if (target) {
        const range = prefix + target;
        // only advisories that name a fixed version are known to be fixed by the target
        const fixed = direct.filter((v) => v.fixedIn && compare(target, v.fixedIn) >= 0).length;
        fixes.push({ type: 'setVersion', range, title: `Update ${e.name} to ${range} (fixes ${fixed} ${fixed === 1 ? 'advisory' : 'advisories'})` });
      }
      for (const id of new Set(direct.map((v) => v.id))) fixes.push({ type: 'ignoreAdvisory', id, title: `Ignore advisory ${id}` });
      // without a lockfile or node_modules nothing is installed: the versions checked are the published ones the range allows
      const guessed = r.installedFrom?.get(e.name) === 'floor';
      const count = `${direct.length} known ${direct.length === 1 ? 'vulnerability' : 'vulnerabilities'}`;
      out.push({
        kind: 'vuln',
        entry: e,
        level: diagLevel(worst.severity),
        code: worst.id,
        url: worst.url,
        message: (guessed ? `${guessedLead(e.name, e.range, installed, direct)}: ${count}` :`${e.name}@${installed ?? '?'} has ${count}`) + ` (${breakdown(direct)})` +
          (need ? `. Fixed in ${need}.` : '. No fixed version known.') + '\n' + advisoryLines(direct),
        inline: target ? `⚠ ${direct.length} vuln${direct.length === 1 ? '' : 's'} → ${prefix + target}` : `⚠ ${direct.length} vuln${direct.length === 1 ? '' : 's'}`,
        fixes,
      });
    }

    // --- vulnerabilities pulled in transitively
    const groups = new Map<string, Hit[]>();
    for (const h of mine.filter((x) => x.path.length > 1)) {
      const k = `${h.vuln.pkg}@${h.vuln.version}`;
      groups.set(k, [...(groups.get(k) ?? []), h]);
    }
    for (const hs of groups.values()) {
      const vs = [...new Map(hs.map((h) => [h.vuln.id, h.vuln])).values()];
      const worst = top(vs);
      const need = maxFixed(vs);
      const p = hs[0].path;
      const fixes: Fix[] = [];
      // A Pin forces every copy of the package. It is not offered when that would drag a copy in another major along, or when the
      // package is also declared directly (npm refuses an override that disagrees with a direct dependency; fix that line instead).
      const others = (r.copies?.get(worst.pkg) ?? []).filter((v) => v !== worst.version);
      const declared = r.entries.some((x) => x.name === worst.pkg) || !!r.rootDeclared?.has(worst.pkg);
      const pinnable = !!need && !declared && !others.some((v) => major(v) !== major(need));
      if (need && pinnable) {
        const range = `^${need}`;
        fixes.push({
          type: 'addOverride',
          section: overrideSection,
          name: worst.pkg,
          range,
          title: `Pin ${worst.pkg} to ${range} via ${overrideSection} (fixes ${vs.length} ${vs.length === 1 ? 'advisory' : 'advisories'})`,
        });
      }
      for (const id of vs.map((v) => v.id)) fixes.push({ type: 'ignoreAdvisory', id, title: `Ignore advisory ${id}` });
      out.push({
        kind: 'transitive',
        entry: e,
        level: diagLevel(worst.severity) === 'error' ? 'warning' : diagLevel(worst.severity),
        code: worst.id,
        url: worst.url,
        message: `Transitive: ${worst.pkg}@${worst.version || '?'} (via ${p.join(' › ')}) has ${vs.length} known ${vs.length === 1 ? 'vulnerability' : 'vulnerabilities'} (${breakdown(vs)})` +
          (need ? `. Fixed in ${need}.` : '.') + '\n' + advisoryLines(vs),
        inline: `⚠ ${worst.pkg} ${vs.length} vuln${vs.length === 1 ? '' : 's'}${pinnable ? ` → ^${need}` : ''}`,
        fixes,
      });
    }

    // --- node_modules / lockfile out of step with the declared range
    if (s.checkSync && !s.ignoredPackages.includes(e.name) && !SKIP_RANGE.test(e.range) && !isTagRange(e.range)) {
      const disk = r.onDisk?.get(e.name);
      const from = r.installedFrom?.get(e.name);
      const locked = from === 'lock' ? installed : undefined;
      const why =
        !r.hasNodeModules || e.section === 'optionalDependencies' ? undefined
        : !disk ? 'is not installed'
        : !satisfies(disk, e.range) ? `has ${disk} installed, which doesn't satisfy ${e.range}`
        : locked && !satisfies(locked, e.range) ? `is locked at ${locked}, which doesn't satisfy ${e.range}`
        : locked && locked !== disk ? `has ${disk} in node_modules but ${locked} in the lockfile`
        : undefined;
      const base = baseVersion(e.range);
      if (why) {
        out.push({
          kind: 'unsynced',
          entry: e,
          level: 'warning',
          message: `${e.name} ${why}. Run ${r.pm.installCmd} to sync node_modules with package.json.`,
          inline: disk ? `⟳ ${disk} installed` : '⟳ not installed',
          fixes: [{ type: 'install', title: `Run \`${r.pm.installCmd}\`` }],
        });
      } else if (installed && base && (prefix === '^' || prefix === '~') && (from === 'lock' || from === 'node_modules') && gt(installed, base) && satisfies(installed, e.range)) {
        out.push({
          kind: 'stale',
          entry: e,
          level: 'info',
          message: `${e.name}: ${installed} is installed but package.json still says ${e.range}`,
          inline: `≡ ${installed} installed`,
          fixes: [
            { type: 'setVersion', range: prefix + installed, title: `Set ${e.name} range to ${prefix + installed} (matches installed)` },
            { type: 'ignorePackage', name: e.name, title: `Don't suggest updates for ${e.name}` },
          ],
        });
      }
    }

    // --- updates / deprecation
    if (!s.enableOutdated || !installed || !info || s.ignoredPackages.includes(e.name)) continue;
    const dep = info.deprecated[installed];
    if (dep) {
      out.push({ kind: 'deprecated', entry: e, level: 'warning', message: `${e.name}@${installed} is deprecated: ${dep}`, inline: '⚠ deprecated', fixes: [] });
    }
    const sug = suggest(installed, info);
    if (sug.inMajor && !(appliedTarget && compare(sug.inMajor, appliedTarget) <= 0)) {
      const kind = diffKind(installed, sug.inMajor)!;
      const range = prefix + sug.inMajor;
      out.push({
        kind: 'outdated',
        entry: e,
        level: 'info',
        message: `${e.name}: ${kind} update available ${installed} → ${sug.inMajor}`,
        inline: `↑ ${sug.inMajor}`,
        fixes: [
          { type: 'setVersion', range, title: `Update ${e.name} to ${range} (${kind})` },
          { type: 'ignorePackage', name: e.name, title: `Don't suggest updates for ${e.name}` },
        ],
      });
    }
    if (sug.nextMajor && s.showMajorUpdates) {
      const range = prefix + sug.nextMajor;
      out.push({
        kind: 'outdated',
        entry: e,
        level: 'info',
        message: `${e.name}: major update available ${installed} → ${sug.nextMajor} (check the changelog for breaking changes)`,
        inline: `⇡ ${sug.nextMajor} major`,
        fixes: [
          { type: 'setVersion', range, major: true, title: `Update ${e.name} to ${range} (MAJOR)` },
          { type: 'ignorePackage', name: e.name, title: `Don't suggest updates for ${e.name}` },
        ],
      });
    }
  }
  return out;
}
