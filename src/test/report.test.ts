import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFindings } from '../analysis/findings';
import { buildUpgradeReport, compatKey, formatUpgradeReport } from '../analysis/report';
import { CompatMap, CompatReport, Finding, Hit, Manifest, RegistryInfo, ScanResult, Settings, Severity } from '../types';

const settings: Settings = { enableVulnerabilities: true, checkTransitive: true, enableOutdated: true, showMajorUpdates: true, checkSync: true, minSeverity: 'low', auditFallback: false, registry: 'https://registry.npmjs.org', ignoredAdvisories: [], ignoredPackages: [] };

type Dep = { name: string; installed: string; versions: string[]; deprecated?: Record<string, string>; section?: 'dependencies' | 'devDependencies'; manifests?: Record<string, Manifest> };

function scanOf(deps: Dep[], pm: 'npm' | 'yarn' = 'npm', overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    entries: deps.map((d, i) => ({ name: d.name, range: '^' + d.installed, section: d.section ?? 'dependencies', line: i, nameStart: 0, end: 0, versionStart: 0, versionEnd: 0 })),
    installed: new Map(deps.map((d) => [d.name, d.installed])),
    hits: [],
    info: new Map(deps.map((d): [string, RegistryInfo] => [d.name, { versions: d.versions, deprecated: d.deprecated ?? {}, manifests: d.manifests ?? {} }])),
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
  assert.deepEqual(r.summary, { safe: 3, caution: 1, major: 1, security: 0, deprecated: 0, vulnerabilities: { direct: 0, transitive: 0 } });
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

const hit = (path: string[], pkg: string, version: string, id: string, fixedIn?: string, severity: Severity = 'moderate'): Hit => ({
  root: path[0],
  path,
  vuln: { id, url: '', summary: id, severity, fixedIn, pkg, version },
});

/** A scan of rimraf, supertest and jest whose only Vulnerabilities are transitive. */
function transitiveScan(pm: 'npm' | 'yarn' = 'npm', extra: Partial<ScanResult> = {}): ScanResult {
  return scanOf(
    [
      { name: 'rimraf', installed: '5.0.0', versions: ['5.0.0', '5.0.1', '5.1.0', '6.0.0'], manifests: { '5.0.1': { dependencies: { glob: '^10.3.7' } }, '5.1.0': { dependencies: { glob: '^10.5.0' } }, '6.0.0': { dependencies: { glob: '^11.0.0' } } } },
      { name: 'supertest', installed: '7.0.0', versions: ['7.0.0', '7.1.0'], manifests: { '7.1.0': { dependencies: { superagent: '^10.2.0' } } } },
      { name: 'jest', installed: '29.0.0', versions: ['29.0.0', '29.7.0'], manifests: { '29.7.0': { dependencies: { glob: '^99.0.0' } } } },
    ],
    pm,
    {
      hits: [
        hit(['rimraf', 'glob'], 'glob', '10.4.0', 'GHSA-glob-1', '10.5.0'),
        hit(['rimraf', 'glob'], 'glob', '10.4.0', 'GHSA-glob-2', '10.4.5', 'high'),
        hit(['jest', '@jest/core', 'glob'], 'glob', '10.4.0', 'GHSA-glob-1', '10.5.0'),
        hit(['jest', '@jest/core', 'glob'], 'glob', '10.4.0', 'GHSA-glob-2', '10.4.5', 'high'),
        hit(['supertest', 'superagent', 'qs'], 'qs', '6.13.0', 'GHSA-qs', '6.14.1', 'low'),
      ],
      ...extra,
    },
  );
}

const reportOf = (scan: ScanResult, s: Settings = settings) => buildUpgradeReport(scan, buildFindings(scan, s), s, 'p');
const vulnOf = (r: ReturnType<typeof buildUpgradeReport>, key: string) => r.vulns.find((v) => `${v.name}@${v.version}` === key);

test('Transitive vulnerabilities are all listed, one row per package version, with every direct dependency that pulls them in', () => {
  const r = reportOf(transitiveScan());
  assert.deepEqual(
    r.vulns.map((v) => `${v.name}@${v.version}`),
    ['glob@10.4.0', 'qs@6.13.0'],
  );
  const glob = vulnOf(r, 'glob@10.4.0')!;
  assert.deepEqual(glob.parents, ['jest', 'rimraf']);
  assert.equal(glob.direct, false);
  assert.equal(glob.severity, 'high');
  assert.deepEqual(glob.advisories, ['GHSA-glob-1', 'GHSA-glob-2']);
  assert.equal(glob.fixedIn, '10.5.0');
  assert.deepEqual(vulnOf(r, 'qs@6.13.0')!.parents, ['supertest']);
  // one Vulnerability per Advisory per copy
  assert.deepEqual(r.summary.vulnerabilities, { direct: 0, transitive: 3 });
});

test('direct Vulnerabilities are counted apart from transitive ones and offer the Update', () => {
  const scan = scanOf([{ name: 'a', installed: '1.0.0', versions: ['1.0.0', '1.0.5'] }], 'npm', { hits: [hit(['a'], 'a', '1.0.0', 'GHSA-a', '1.0.5', 'critical')] });
  const r = reportOf(scan);
  const a = vulnOf(r, 'a@1.0.0')!;
  assert.equal(a.direct, true);
  assert.deepEqual(a.parents, ['a']);
  assert.ok(a.fixes.some((f) => /Update a to \^1\.0\.5/.test(f)));
  assert.deepEqual(r.summary.vulnerabilities, { direct: 1, transitive: 0 });
  assert.deepEqual(rowOf(r, 'a', 'patch')?.fixes, ['a@1.0.0']);
});

test('the report applies the same minimum Severity and ignored Advisories as the Findings', () => {
  const s = { ...settings, minSeverity: 'moderate' as const, ignoredAdvisories: ['GHSA-glob-2'] };
  const r = reportOf(transitiveScan(), s);
  assert.deepEqual(
    r.vulns.map((v) => `${v.name}@${v.version}`),
    ['glob@10.4.0'],
  );
  assert.deepEqual(vulnOf(r, 'glob@10.4.0')!.advisories, ['GHSA-glob-1']);
  assert.deepEqual(r.summary.vulnerabilities, { direct: 0, transitive: 1 });
});

test("an upgrade is marked as fixing a Transitive vulnerability only when its direct child's range reaches the fixed version", () => {
  const r = reportOf(transitiveScan());
  assert.deepEqual(rowOf(r, 'rimraf', 'minor')?.fixes, ['glob@10.4.0']); // ^10.5.0 >= 10.5.0
  assert.equal(rowOf(r, 'rimraf', 'minor')?.fixesVuln, true);
  assert.deepEqual(rowOf(r, 'rimraf', 'major')?.fixes, ['glob@10.4.0']);
  assert.deepEqual(rowOf(r, 'rimraf', 'patch')?.fixes, []); // ^10.3.7 is below the fix
  assert.equal(rowOf(r, 'rimraf', 'patch')?.fixesVuln, false);
  assert.deepEqual(rowOf(r, 'jest', 'minor')?.fixes, []); // glob is deeper on jest's path
  assert.deepEqual(rowOf(r, 'supertest', 'minor')?.fixes, []); // qs is under superagent, not a direct child
  assert.equal(r.summary.security, 2);
  assert.ok(vulnOf(r, 'glob@10.4.0')!.fixes.includes('Update rimraf to 5.1.0'));
});

test('a Vulnerability row offers the Pin when one is safe', () => {
  const r = reportOf(transitiveScan());
  assert.ok(vulnOf(r, 'qs@6.13.0')!.fixes.some((f) => /^Pin qs to \^6\.14\.1 via overrides/.test(f)));
  assert.equal(vulnOf(r, 'qs@6.13.0')!.noFix, undefined);
});

test('without a Pin the row says why, and yarn projects get a scoped-resolution hint', () => {
  const scan = transitiveScan('yarn', { copies: new Map([['qs', ['6.13.0', '5.2.0']]]) });
  scan.pm.overrideSection = 'resolutions';
  const qs = vulnOf(reportOf(scan), 'qs@6.13.0')!;
  assert.deepEqual(qs.fixes, []);
  assert.match(qs.noFix!, /several majors/);
  assert.match(qs.hint!, /"\*\*\/superagent\/qs": "\^6\.14\.1"/);

  const npm = vulnOf(reportOf(transitiveScan('npm', { copies: new Map([['qs', ['6.13.0', '5.2.0']]]) })), 'qs@6.13.0')!;
  assert.equal(npm.hint, undefined);
});

test('markdown: summary, then Vulnerabilities, then the upgrade sections; Vulnerabilities are counted apart from upgrades that fix one', () => {
  const md = formatUpgradeReport(reportOf(transitiveScan()));
  const at = (s: string) => md.indexOf(s);
  assert.ok(at('known vulnerabilities') > 0);
  assert.ok(at('known vulnerabilities') < at('## 🛡️ Vulnerabilities'));
  assert.ok(at('## 🛡️ Vulnerabilities') < at('## ✅ Safe to upgrade now'));
  assert.match(md, /\*\*3\*\* known vulnerabilities \(0 direct, 3 transitive\)/);
  assert.match(md, /\*\*2\*\* upgrades fix a known vulnerability/);
  assert.match(md, /\| glob@10\.4\.0 \| high \| GHSA-glob-1, GHSA-glob-2 \| jest, rimraf \| 10\.5\.0 \|/);
  assert.match(md, /🔒 fixes glob@10\.4\.0/);
});

test('a project whose only problem is a Transitive vulnerability is not reported as up to date', () => {
  const scan = scanOf([{ name: 'a', installed: '1.0.0', versions: ['1.0.0'] }], 'npm', { hits: [hit(['a', 'b'], 'b', '2.0.0', 'GHSA-b')] });
  const md = formatUpgradeReport(reportOf(scan));
  assert.doesNotMatch(md, /Everything is up to date/);
  assert.match(md, /\| b@2\.0\.0 \|/);
  assert.match(md, /no fixed version known/);
});
