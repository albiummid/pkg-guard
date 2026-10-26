import { DepEntry } from './packageJson';
import { pickAtLeast, suggest } from './registry';
import { ScanResult, Settings } from './scan';
import { compare, diffKind, gt, prefixOf } from './semver';
import { Hit, SEVERITY_RANK, Severity, Vuln } from './types';

export type Fix =
  | { type: 'setVersion'; title: string; range: string; major?: boolean }
  | { type: 'addOverride'; title: string; section: string; name: string; range: string }
  | { type: 'ignoreAdvisory'; title: string; id: string }
  | { type: 'ignorePackage'; title: string; name: string };

export interface Finding {
  kind: 'vuln' | 'transitive' | 'outdated' | 'deprecated';
  entry: DepEntry;
  severity: 'error' | 'warning' | 'info';
  message: string;
  code?: string;
  url?: string;
  /** short ghost text shown at the end of the line */
  inline: string;
  fixes: Fix[];
}

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

function diagSeverity(s: Severity): Finding['severity'] {
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

export function buildFindings(r: ScanResult, s: Settings): Finding[] {
  const out: Finding[] = [];
  const minRank = SEVERITY_RANK[s.minSeverity];
  const ignored = new Set(s.ignoredAdvisories);
  const hits = r.hits.filter((h) => SEVERITY_RANK[h.vuln.severity] >= minRank && !ignored.has(h.vuln.id));
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
        fixes.push({ type: 'setVersion', range, title: `Update ${e.name} to ${range} (fixes ${direct.length} ${direct.length === 1 ? 'advisory' : 'advisories'})` });
      }
      for (const id of new Set(direct.map((v) => v.id))) fixes.push({ type: 'ignoreAdvisory', id, title: `Ignore advisory ${id}` });
      out.push({
        kind: 'vuln',
        entry: e,
        severity: diagSeverity(worst.severity),
        code: worst.id,
        url: worst.url,
        message: `${e.name}@${installed ?? '?'} has ${direct.length} known ${direct.length === 1 ? 'vulnerability' : 'vulnerabilities'} (${breakdown(direct)})` +
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
      if (need) {
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
        severity: diagSeverity(worst.severity) === 'error' ? 'warning' : diagSeverity(worst.severity),
        code: worst.id,
        url: worst.url,
        message: `Transitive: ${worst.pkg}@${worst.version || '?'} (via ${p.join(' › ')}) has ${vs.length} known ${vs.length === 1 ? 'vulnerability' : 'vulnerabilities'} (${breakdown(vs)})` +
          (need ? `. Fixed in ${need}.` : '.') + '\n' + advisoryLines(vs),
        inline: `⚠ ${worst.pkg} ${vs.length} vuln${vs.length === 1 ? '' : 's'}${need ? ` → ^${need}` : ''}`,
        fixes,
      });
    }

    // --- updates / deprecation
    if (!s.enableOutdated || !installed || !info || s.ignoredPackages.includes(e.name)) continue;
    const dep = info.deprecated[installed];
    if (dep) {
      out.push({ kind: 'deprecated', entry: e, severity: 'warning', message: `${e.name}@${installed} is deprecated: ${dep}`, inline: '⚠ deprecated', fixes: [] });
    }
    const sug = suggest(installed, info);
    if (sug.inMajor && !(appliedTarget && compare(sug.inMajor, appliedTarget) <= 0)) {
      const kind = diffKind(installed, sug.inMajor)!;
      const range = prefix + sug.inMajor;
      out.push({
        kind: 'outdated',
        entry: e,
        severity: 'info',
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
        severity: 'info',
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
