import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildUpgradeReport, compatKey, formatUpgradeReport } from '../analysis/report';
import { CompatMap, CompatReport, Finding, RegistryInfo, ScanResult, Settings } from '../types';
import { OverrideAudit } from '../types/overrides';

const settings: Settings = { enableVulnerabilities: true, checkTransitive: true, enableOutdated: true, showMajorUpdates: true, checkSync: true, minSeverity: 'low', auditFallback: false, registry: 'https://registry.npmjs.org', ignoredAdvisories: [], ignoredPackages: [] };

type Dep = { name: string; installed: string; versions: string[]; deprecated?: Record<string, string>; section?: 'dependencies' | 'devDependencies' };

function scanOf(deps: Dep[], pm: 'npm' | 'yarn' = 'npm', overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    entries: deps.map((d, i) => ({ name: d.name, range: '^' + d.installed, section: d.section ?? 'dependencies', line: i, nameStart: 0, end: 0, versionStart: 0, versionEnd: 0 })),
    installed: new Map(deps.map((d) => [d.name, d.installed])),
    hits: [],
    info: new Map(deps.map((d): [string, RegistryInfo] => [d.name, { versions: d.versions, deprecated: d.deprecated ?? {}, manifests: {} }])),
    lock: 'none',
    pm: { name: pm, installCmd: `${pm} install`, overrideSection: 'overrides' },
    source: 'none',
    notes: [],
    ...overrides,
  } as ScanResult;
}

const rowOf = (r: ReturnType<typeof buildUpgradeReport>, name: string, kind: string) => r.rows.find((x) => x.name === name && x.kind === kind);

test('buckets: patch and stable minor are safe, 0.x minor is caution, major is major', () => {
  const r = buildUpgradeReport(
    scanOf([
      { name: 'stable', installed: '1.2.0', versions: ['1.2.0', '1.2.5', '1.3.0', '2.0.0'] },
      { name: 'zero', installed: '0.4.0', versions: ['0.4.0', '0.4.2', '0.5.0'] },
    ]),
    [],
    settings,
  );
  assert.equal(rowOf(r, 'stable', 'patch')?.bucket, 'safe');
  assert.equal(rowOf(r, 'stable', 'minor')?.bucket, 'safe');
  assert.equal(rowOf(r, 'stable', 'major')?.bucket, 'major');
  assert.equal(rowOf(r, 'zero', 'patch')?.bucket, 'safe');
  assert.equal(rowOf(r, 'zero', 'minor')?.bucket, 'caution');
  assert.deepEqual(r.summary, { safe: 3, caution: 1, major: 1, security: 0, deprecated: 0 });
});

test('a peer or engines problem moves a non-major upgrade to caution; info issues do not', () => {
  const scan = scanOf([
    { name: 'a', installed: '1.0.0', versions: ['1.0.0', '1.1.0'] },
    { name: 'b', installed: '1.0.0', versions: ['1.0.0', '1.0.1'] },
  ]);
  const bad: CompatReport = { issues: [{ level: 'error', text: 'needs peer react ^19, but 18.2.0 is installed' }], companions: [] };
  const fine: CompatReport = { issues: [{ level: 'info', text: 'ok' }], companions: [] };
  const compat: CompatMap = new Map([[compatKey('a', '1.1.0'), bad], [compatKey('b', '1.0.1'), fine]]);
  const r = buildUpgradeReport(scan, [], settings, 'p', compat);
  assert.equal(rowOf(r, 'a', 'minor')?.bucket, 'caution');
  assert.deepEqual(rowOf(r, 'a', 'minor')?.notes, ['needs peer react ^19, but 18.2.0 is installed']);
  assert.equal(rowOf(r, 'b', 'patch')?.bucket, 'safe');
  assert.ok(rowOf(r, 'b', 'patch')?.checked);
});

test('without a compatibility check the report says safe is by version number only', () => {
  const r = buildUpgradeReport(scanOf([{ name: 'a', installed: '1.0.0', versions: ['1.0.0', '1.0.1'] }]), [], settings);
  assert.ok(r.notes.some((n) => /not checked/i.test(n)));
  assert.equal(rowOf(r, 'a', 'patch')?.checked, false);
});

test('upgrades reaching a vulnerability fix are flagged', () => {
  const scan = scanOf([{ name: 'a', installed: '1.0.0', versions: ['1.0.0', '1.0.1', '1.0.5', '2.0.0'] }]);
  const finding = { kind: 'vuln', entry: scan.entries[0], level: 'error', message: 'm', inline: '', fixes: [{ type: 'setVersion', title: 't', range: '^1.0.5' }] } as Finding;
  const r = buildUpgradeReport(scan, [finding], settings);
  assert.equal(rowOf(r, 'a', 'patch')?.fixesVuln, true); // newest patch is 1.0.5
  assert.equal(rowOf(r, 'a', 'major')?.fixesVuln, true);
  assert.equal(r.summary.security, 2);
});

test('deprecated installed versions are listed; ignored packages and prereleases are skipped', () => {
  const r = buildUpgradeReport(
    scanOf([
      { name: 'old', installed: '1.0.0', versions: ['1.0.0', '1.1.0-beta.1'], deprecated: { '1.0.0': 'use new' } },
      { name: 'skipme', installed: '1.0.0', versions: ['1.0.0', '1.0.1'] },
    ]),
    [],
    { ...settings, ignoredPackages: ['skipme'] },
  );
  assert.deepEqual(r.deprecated, [{ name: 'old', installed: '1.0.0', message: 'use new' }]);
  assert.deepEqual(r.rows, []);
});

test('missing registry data is reported, and a fully current project says so', () => {
  const scan = scanOf([{ name: 'a', installed: '1.0.0', versions: ['1.0.0'] }]);
  const current = buildUpgradeReport(scan, [], settings);
  assert.match(formatUpgradeReport(current), /Everything is up to date/);

  scan.info.delete('a');
  const missing = buildUpgradeReport(scan, [], settings);
  assert.ok(missing.notes.some((n) => /not checked/.test(n)));
  assert.doesNotMatch(formatUpgradeReport(missing), /Everything is up to date/);

  const off = buildUpgradeReport(scan, [], { ...settings, enableOutdated: false });
  assert.ok(off.notes.some((n) => /disabled/.test(n)));
});

test('markdown: grouped sections with install commands for the detected package manager', () => {
  const scan = scanOf(
    [
      { name: 'lib', installed: '1.0.0', versions: ['1.0.0', '1.0.2', '1.1.0', '2.0.0'] },
      { name: 'tool', installed: '3.0.0', versions: ['3.0.0', '3.0.1'], section: 'devDependencies' },
    ],
    'yarn',
  );
  const md = formatUpgradeReport(buildUpgradeReport(scan, [], settings, 'demo'));
  assert.match(md, /^# Upgrade report: demo/);
  assert.ok(md.indexOf('Safe to upgrade now') < md.indexOf('Major upgrades'));
  assert.match(md, /yarn add lib@1\.1\.0\n/); // minor supersedes the patch in one command
  assert.match(md, /yarn add -D tool@3\.0\.1/);
  assert.match(md, /yarn add lib@2\.0\.0/);
});

test('overrides: every verdict is rendered from the precomputed audit, after the upgrade sections', () => {
  const scan = scanOf([{ name: 'lib', installed: '1.0.0', versions: ['1.0.0', '2.0.0'], deprecated: { '1.0.0': 'old' } }], 'yarn');
  const audit: OverrideAudit = {
    section: 'resolutions',
    lockfile: 'yarn-classic',
    rows: [
      { key: 'uuid', name: 'uuid', value: '^11.1.1', verdict: 'still-needed', forced: '11.1.1', requests: [{ range: '^8.3.0', by: ['exceljs'], fresh: '8.3.2', advisories: ['GHSA-uuid'], otherMajor: true }] },
      { key: 'body-parser', name: 'body-parser', value: '^2.4.0', verdict: 'redundant', forced: '2.4.0', requests: [{ range: '^2.2.1', by: ['express'], fresh: '2.4.0', advisories: [], otherMajor: false }] },
      {
        key: 'js-yaml',
        name: 'js-yaml',
        value: '^5.4.1',
        verdict: 'forces-other-major',
        forced: '5.5.0',
        requests: [
          { range: '^3.13.1', by: ['@istanbuljs/load-nyc-config'], fresh: '3.15.2', advisories: [], otherMajor: true },
          { range: '5.3.0', by: ['@nestjs/swagger'], fresh: '5.3.0', advisories: ['GHSA-yaml'], otherMajor: false },
        ],
      },
      { key: '**/parent/gone', name: 'gone', value: '1.0.0', verdict: 'unused', requests: [] },
      { key: 'nested', name: 'nested', value: '', verdict: 'not-checked', reason: 'registry lookup failed', requests: [] },
    ],
  };
  const r = buildUpgradeReport(scan, [], settings, 'p', undefined, audit);
  assert.equal(r.overrides, audit);
  const md = formatUpgradeReport(r);
  const at = md.indexOf('## 🧷 Overrides');
  assert.ok(at > md.indexOf('Major upgrades') && at < md.indexOf('Deprecated packages'));
  const line = (key: string) => md.split('\n').find((l) => l.startsWith(`| ${key} |`)) ?? '';
  assert.match(line('uuid'), /still needed.*\^8\.3\.0 \(exceljs\) would get 8\.3\.2, which has GHSA-uuid/);
  assert.match(line('body-parser'), /no longer needed.*\^2\.2\.1 \(express\) would get 2\.4\.0/);
  assert.match(line('js-yaml'), /forces another major.*\^3\.13\.1 \(@istanbuljs\/load-nyc-config\).*onto 5\.5\.0.*GHSA-yaml/);
  assert.match(line('**/parent/gone'), /unused.*parent.*does not request gone/);
  assert.match(line('nested'), /not checked.*registry lookup failed/);
  assert.match(md, /yarn v1.*locked until its lockfile entries are re-resolved/);
});

test('overrides: no section without entries, and no yarn v1 reminder for other lockfiles', () => {
  const scan = scanOf([{ name: 'lib', installed: '1.0.0', versions: ['1.0.0', '1.0.1'] }]);
  assert.doesNotMatch(formatUpgradeReport(buildUpgradeReport(scan, [], settings, 'p', undefined, { section: 'overrides', lockfile: 'npm', rows: [] })), /Overrides/);
  const md = formatUpgradeReport(
    buildUpgradeReport(scan, [], settings, 'p', undefined, { section: 'pnpm.overrides', lockfile: 'pnpm', rows: [{ key: 'a', name: 'a', value: '1', verdict: 'not-checked', reason: 'pnpm lockfiles are not checked', requests: [] }] }),
  );
  assert.match(md, /`pnpm\.overrides`/);
  assert.doesNotMatch(md, /yarn v1/);
});
