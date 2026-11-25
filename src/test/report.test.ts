import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildUpgradeReport, compatKey, formatUpgradeReport } from '../analysis/report';
import { CompatMap, CompatReport, Finding, RegistryInfo, ScanResult, Settings } from '../types';

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
  assert.equal(rowOf(r, 'stable', 'patch'), undefined); // same bucket as its minor row
  assert.equal(rowOf(r, 'stable', 'minor')?.bucket, 'safe');
  assert.equal(rowOf(r, 'stable', 'major')?.bucket, 'major');
  assert.equal(rowOf(r, 'zero', 'patch')?.bucket, 'safe');
  assert.equal(rowOf(r, 'zero', 'minor')?.bucket, 'caution');
  assert.deepEqual(r.summary, { safe: 2, caution: 1, major: 1, security: 0, deprecated: 0 }); // stable's patch row is folded into its minor row
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

test('each dependency not checked is named with its reason, and the scan notes are carried into the report', () => {
  const scan = scanOf(
    [
      { name: 'ok', installed: '1.0.0', versions: ['1.0.0', '1.0.1'] },
      { name: 'offline', installed: '1.0.0', versions: [] },
      { name: 'absent', installed: '1.0.0', versions: [] },
    ],
    'npm',
    { notes: ['bun.lockb is not supported yet; transitive vulnerability checks are off'] },
  );
  scan.info.delete('offline');
  scan.installed.delete('absent');
  const r = buildUpgradeReport(scan, [], settings);
  assert.deepEqual(r.unchecked, [
    { name: 'offline', reason: 'registry lookup failed' },
    { name: 'absent', reason: 'not installed' },
  ]);
  const md = formatUpgradeReport(r);
  assert.match(md, /not checked because the registry lookup failed: offline/);
  assert.match(md, /not checked because it is not installed: absent/);
  assert.match(md, /bun\.lockb is not supported yet/);
});

test('one row per package per bucket: a patch row is dropped when the minor row lands in the same bucket', () => {
  const scan = scanOf([
    { name: 'same', installed: '1.0.0', versions: ['1.0.0', '1.0.1', '1.1.0'] },
    { name: 'split', installed: '1.0.0', versions: ['1.0.0', '1.0.1', '1.1.0'] },
  ]);
  const bad: CompatReport = { issues: [{ level: 'warning', text: 'requires Node >=22' }], companions: [] };
  const ok: CompatReport = { issues: [], companions: [] };
  const compat: CompatMap = new Map([
    [compatKey('same', '1.0.1'), ok],
    [compatKey('same', '1.1.0'), ok],
    [compatKey('split', '1.0.1'), ok],
    [compatKey('split', '1.1.0'), bad],
  ]);
  const r = buildUpgradeReport(scan, [], settings, 'p', compat);
  assert.equal(rowOf(r, 'same', 'patch'), undefined);
  assert.equal(rowOf(r, 'same', 'minor')?.bucket, 'safe');
  assert.equal(rowOf(r, 'split', 'patch')?.bucket, 'safe'); // the safe smaller step stays visible
  assert.equal(rowOf(r, 'split', 'minor')?.bucket, 'caution');
  for (const b of ['safe', 'caution', 'major']) {
    const names = r.rows.filter((x) => x.bucket === b).map((x) => x.name);
    assert.equal(new Set(names).size, names.length, `duplicate row in ${b}`);
  }
  assert.deepEqual(r.summary, { safe: 2, caution: 1, major: 0, security: 0, deprecated: 0 });
});

test('@types/node above the lowest Node major of engines.node gets a note; within it stays safe', () => {
  const types = (installed: string, versions: string[]) =>
    scanOf([{ name: '@types/node', installed, versions, section: 'devDependencies' }], 'npm', { projectNode: '>=24.0.0' });
  const r = buildUpgradeReport(types('24.0.0', ['24.0.0', '24.0.3', '24.5.0', '26.1.0']), [], settings, 'p', new Map());
  assert.equal(rowOf(r, '@types/node', 'minor')?.bucket, 'safe');
  assert.deepEqual(rowOf(r, '@types/node', 'minor')?.notes, []);
  const major = rowOf(r, '@types/node', 'major');
  assert.equal(major?.bucket, 'major');
  assert.ok(major?.notes.some((n) => /Node 26/.test(n) && n.includes('>=24.0.0')), String(major?.notes));

  // already on a newer major than the project's Node: a non-major upgrade moves to caution
  const ahead = buildUpgradeReport(types('26.0.0', ['26.0.0', '26.1.0']), [], settings, 'p', new Map());
  assert.equal(rowOf(ahead, '@types/node', 'minor')?.bucket, 'caution');
  assert.ok(rowOf(ahead, '@types/node', 'minor')?.notes.some((n) => n.includes('>=24.0.0')));
  assert.match(formatUpgradeReport(r), /engines\.node/);

  // no engines.node: no note
  const free = buildUpgradeReport(scanOf([{ name: '@types/node', installed: '24.0.0', versions: ['24.0.0', '26.1.0'] }]), [], settings);
  assert.deepEqual(rowOf(free, '@types/node', 'major')?.notes, []);
});

test('a peer another row upgrades to is "upgrade together", not caution; already-the-case notes are shown as info', () => {
  const scan = scanOf([
    { name: 'plugin', installed: '8.68.0', versions: ['8.68.0', '8.74.0'] },
    { name: 'parser', installed: '8.68.0', versions: ['8.68.0', '8.74.0', '9.0.0'] },
    { name: 'lonely', installed: '1.0.0', versions: ['1.0.0', '1.1.0'] },
    { name: 'orm', installed: '1.1.0', versions: ['1.1.0', '1.1.3'] },
  ]);
  const compat: CompatMap = new Map([
    [compatKey('plugin', '8.74.0'), { issues: [{ level: 'error', text: 'needs peer parser ^8.74.0, but 8.68.0 is installed', peer: { name: 'parser', range: '^8.74.0' } }], companions: [] }],
    // only parser's major row meets ^9, and a major is not a safer bucket than a minor
    [compatKey('lonely', '1.1.0'), { issues: [{ level: 'error', text: 'needs peer parser ^9.0.0, but 8.68.0 is installed', peer: { name: 'parser', range: '^9.0.0' } }], companions: [] }],
    [compatKey('orm', '1.1.3'), { issues: [{ level: 'info', text: 'needs peer ioredis ^5, but 6.0.0 is installed; already the case with installed orm@1.1.0', alreadyTheCase: true }, { level: 'info', text: 'dependencies: adds 1 (x)' }], companions: [] }],
  ]);
  const r = buildUpgradeReport(scan, [], settings, 'p', compat);
  assert.equal(rowOf(r, 'plugin', 'minor')?.bucket, 'safe');
  assert.deepEqual(rowOf(r, 'plugin', 'minor')?.notes, ['upgrade together with parser@8.74.0']);
  assert.equal(rowOf(r, 'lonely', 'minor')?.bucket, 'caution');
  assert.deepEqual(rowOf(r, 'lonely', 'minor')?.notes, ['needs peer parser ^9.0.0, but 8.68.0 is installed']);
  assert.equal(rowOf(r, 'orm', 'patch')?.bucket, 'safe');
  assert.deepEqual(rowOf(r, 'orm', 'patch')?.notes, ['needs peer ioredis ^5, but 6.0.0 is installed; already the case with installed orm@1.1.0']);
  assert.equal(r.summary.caution, 1);
  assert.match(formatUpgradeReport(r), /\| plugin \| 8\.68\.0 \| 8\.74\.0 \| minor \| upgrade together with parser@8\.74\.0 \|/);
});

test('patch rows are folded after the upgrade-together pass, against the final buckets', () => {
  const scan = scanOf([
    { name: 'plugin', installed: '8.68.0', versions: ['8.68.0', '8.68.1', '8.74.0'] },
    { name: 'parser', installed: '8.68.0', versions: ['8.68.0', '8.74.0'] },
  ]);
  const ok: CompatReport = { issues: [], companions: [] };
  const compat: CompatMap = new Map([
    [compatKey('plugin', '8.68.1'), ok],
    [compatKey('plugin', '8.74.0'), { issues: [{ level: 'error', text: 'needs peer parser ^8.74.0, but 8.68.0 is installed', peer: { name: 'parser', range: '^8.74.0' } }], companions: [] }],
    [compatKey('parser', '8.74.0'), ok],
  ]);
  const r = buildUpgradeReport(scan, [], settings, 'p', compat);
  // bucketOf alone would put the minor row in caution and keep the patch row; together with parser it is safe
  assert.equal(rowOf(r, 'plugin', 'minor')?.bucket, 'safe');
  assert.equal(rowOf(r, 'plugin', 'patch'), undefined);
});

test('a pair upgraded together lands in the bucket of its riskier member', () => {
  const scan = scanOf([
    { name: 'a', installed: '1.0.0', versions: ['1.0.0', '1.1.0'] },
    { name: 'b', installed: '1.0.0', versions: ['1.0.0', '1.1.0'] },
  ]);
  const compat: CompatMap = new Map([
    [compatKey('a', '1.1.0'), { issues: [{ level: 'error', text: 'needs peer b ^1.1.0', peer: { name: 'b', range: '^1.1.0' } }], companions: [] }],
    [compatKey('b', '1.1.0'), { issues: [{ level: 'warning', text: 'requires Node >=26' }], companions: [] }],
  ]);
  const r = buildUpgradeReport(scan, [], settings, 'p', compat);
  assert.equal(rowOf(r, 'b', 'minor')?.bucket, 'caution');
  assert.equal(rowOf(r, 'a', 'minor')?.bucket, 'caution');
  assert.deepEqual(rowOf(r, 'a', 'minor')?.notes, ['upgrade together with b@1.1.0']);
});

test('major rows show what blocks them; majors of one family upgraded together do not flag each other', () => {
  const scan = scanOf([
    { name: 'common', installed: '11.2.3', versions: ['11.2.3', '12.0.0'] },
    { name: 'jwt', installed: '11.0.2', versions: ['11.0.2', '12.0.0'] },
    { name: 'blocker', installed: '1.0.0', versions: ['1.0.0'] },
  ]);
  scan.info.get('jwt')!.manifests['12.0.0'] = { peerDependencies: { common: '^12.0.0' } };
  const compat: CompatMap = new Map([
    [
      compatKey('common', '12.0.0'),
      {
        issues: [
          { level: 'error', text: 'jwt@11.0.2 peers on common ^10 || ^11 — update jwt to 12.0.0', dependent: { name: 'jwt', range: '^10 || ^11' } },
          { level: 'error', text: 'blocker@1.0.0 peers on common ^11 and no newer blocker accepts 12.0.0', dependent: { name: 'blocker', range: '^11' } },
          { level: 'info', text: 'dependencies: adds 1 (x)' },
        ],
        companions: [{ name: 'jwt', from: '11.0.2', to: '12.0.0', reason: 'peer common ^10 || ^11' }],
      },
    ],
    [compatKey('jwt', '12.0.0'), { issues: [{ level: 'error', text: 'needs peer common ^12.0.0, but 11.2.3 is installed', peer: { name: 'common', range: '^12.0.0' } }], companions: [] }],
  ]);
  const r = buildUpgradeReport(scan, [], settings, 'p', compat);
  assert.equal(rowOf(r, 'common', 'major')?.bucket, 'major');
  assert.ok(rowOf(r, 'common', 'major')?.checked);
  assert.deepEqual(rowOf(r, 'common', 'major')?.notes, ['blocker@1.0.0 peers on common ^11 and no newer blocker accepts 12.0.0']);
  assert.deepEqual(rowOf(r, 'jwt', 'major')?.notes, []);
  assert.equal(r.summary.major, 2);
  assert.ok(!r.notes.some((n) => /could not be verified/.test(n)));
});
