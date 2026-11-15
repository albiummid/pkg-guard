// Behaviour tests for issue #25: with nothing installed, every published version the Declared range allows is checked.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { buildFindings } from '../analysis/findings';
import { scan } from '../analysis/scan';
import { clearOsvCache, fixedFor, isAffected } from '../sources/osv';
import { clearRegistryCache } from '../sources/registry';
import { Settings } from '../types';

const settings: Settings = {
  enableVulnerabilities: true, checkTransitive: true, enableOutdated: true, showMajorUpdates: true, checkSync: true,
  minSeverity: 'low', auditFallback: false, registry: 'https://registry.example', ignoredAdvisories: [], ignoredPackages: [],
};

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const range = (events: object[]) => [{ package: { ecosystem: 'npm', name: 'p' }, ranges: [{ type: 'SEMVER', events }] }];

/** Published versions of `p`: 1.0.0 to 1.3.0, a 1.4.0 prerelease, and 2.0.0 outside ^1.0.0. */
const PUBLISHED = ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0-beta.1', '2.0.0'];

/**
 * Scans a manifest declaring `p` at `declared` in a folder with no lockfile and no node_modules, against a stubbed registry and
 * an OSV that returns `advisories`. Returns the Findings and every OSV query body.
 */
async function scanFloor(declared: string, advisories: any[]) {
  clearOsvCache();
  clearRegistryCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-allowed-'));
  const text = `{\n  "dependencies": {\n    "p": "${declared}"\n  }\n}\n`;
  const queries: any[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith('/querybatch')) {
      const body = JSON.parse(init.body);
      // a lockfile in a parent of the temp folder adds its own packages; only the queries for p are counted
      queries.push(...body.queries.filter((q: any) => q.package.name === 'p'));
      return json({ results: body.queries.map(() => ({ vulns: advisories.map((a) => ({ id: a.id })) })) });
    }
    if (url.includes('/vulns/')) return json(advisories.find((a) => url.endsWith(`/${a.id}`)));
    if (url.startsWith('https://registry.example/')) {
      return json({ 'dist-tags': { latest: '2.0.0' }, versions: Object.fromEntries(PUBLISHED.map((v) => [v, {}])) });
    }
    return json({}, 404);
  }) as typeof fetch;
  try {
    const r = await scan(text, path.join(dir, 'package.json'), settings);
    return { r, findings: buildFindings(r, settings), queries };
  } finally {
    globalThis.fetch = real;
  }
}

test('an Advisory affecting only a later version the range allows is found, and its Fix raises the range past it', async () => {
  const mal = { id: 'MAL-later', summary: 'malicious release', affected: range([{ introduced: '1.2.0' }, { fixed: '1.3.0' }]) };
  const { r, findings, queries } = await scanFloor('^1.0.0', [mal]);
  assert.equal(r.installedFrom!.get('p'), 'floor');
  const f = findings.find((x) => x.kind === 'vuln')!;
  assert.ok(f, 'expected a vulnerability Finding');
  assert.equal(f.code, 'MAL-later');
  assert.match(f.message, /^p may be vulnerable \(version guessed from \^1\.0\.0, which allows affected 1\.2\.0\)/);
  assert.match(f.message, /Fixed in 1\.3\.0/);
  assert.deepEqual(f.fixes[0], { type: 'setVersion', range: '^1.3.0', title: 'Update p to ^1.3.0 (fixes 1 advisory)' });
  // one query for the package, asked with no version
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0], { package: { name: 'p', ecosystem: 'npm' } });
});

test('an Advisory that affects no version the range allows is not reported', async () => {
  const outside = { id: 'GHSA-outside', affected: range([{ introduced: '2.0.0' }]) };
  // the prerelease is not allowed by ^1.0.0, so an Advisory affecting only it is not reported either
  const pre = { id: 'GHSA-pre', affected: [{ package: { name: 'p' }, versions: ['1.4.0-beta.1'] }] };
  const { findings, queries } = await scanFloor('^1.0.0', [outside, pre]);
  assert.equal(findings.filter((x) => x.kind === 'vuln').length, 0);
  assert.equal(queries.length, 1);
});

test('a range that opts into prereleases checks them', async () => {
  const pre = { id: 'GHSA-pre', affected: [{ package: { name: 'p' }, versions: ['1.4.0-beta.1'] }] };
  const { findings } = await scanFloor('^1.4.0-beta.0', [pre]);
  assert.match(findings.find((x) => x.kind === 'vuln')!.message, /allows affected 1\.4\.0-beta\.1/);
});

test('an Advisory affecting the Floor version still produces a Finding naming every affected allowed version', async () => {
  const old = { id: 'GHSA-old', database_specific: { severity: 'HIGH' }, affected: range([{ introduced: '0' }, { fixed: '1.2.0' }]) };
  const { findings, queries } = await scanFloor('^1.0.0', [old]);
  const f = findings.find((x) => x.kind === 'vuln')!;
  assert.equal(f.level, 'error');
  assert.match(f.message, /which allows affected 1\.0\.0, 1\.1\.0\)/);
  assert.deepEqual(f.fixes[0], { type: 'setVersion', range: '^1.3.0', title: 'Update p to ^1.3.0 (fixes 1 advisory)' });
  assert.equal(queries.length, 1);
});

test('an affected version with no fix leaves the Finding without a fixed version', async () => {
  const open = { id: 'GHSA-open', affected: range([{ introduced: '1.3.0' }]) };
  const { findings } = await scanFloor('^1.0.0', [open]);
  const f = findings.find((x) => x.kind === 'vuln')!;
  assert.match(f.message, /No fixed version known/);
  assert.equal(f.fixes.filter((x) => x.type === 'setVersion').length, 0);
});

test('OSV ranges are matched in version order, with last_affected and explicit versions', () => {
  const affected = [{ package: { name: 'p' }, ranges: [{ type: 'SEMVER', events: [{ fixed: '1.1.0' }, { introduced: '0' }, { introduced: '1.5.0' }, { last_affected: '1.6.0' }] }] }];
  assert.equal(isAffected(affected, 'p', '1.0.0'), true);
  assert.equal(isAffected(affected, 'p', '1.1.0'), false);
  assert.equal(isAffected(affected, 'p', '1.6.0'), true);
  assert.equal(isAffected(affected, 'p', '1.6.1'), false);
  assert.equal(isAffected(affected, 'other', '1.0.0'), false);
  assert.equal(isAffected([{ package: { name: 'p' }, versions: ['3.0.0'] }], 'p', '3.0.0'), true);
});

test('the fixed version of a version comes from the same ordered walk as whether it is affected', () => {
  const affected = [{ package: { name: 'p' }, ranges: [{ type: 'SEMVER', events: [{ fixed: '1.1.0' }, { introduced: '1.5.0' }, { introduced: '0' }, { fixed: '1.7.0' }] }] }];
  assert.equal(fixedFor(affected, 'p', '1.0.0'), '1.1.0');
  assert.equal(fixedFor(affected, 'p', '1.6.0'), '1.7.0');
  assert.equal(fixedFor(affected, 'p', '1.2.0'), undefined, 'not affected, so nothing fixes it');
  // a range closed by last_affected names no fix
  const last = [{ package: { name: 'p' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { last_affected: '1.6.0' }, { introduced: '2.0.0' }, { fixed: '2.1.0' }] }] }];
  assert.equal(fixedFor(last, 'p', '1.0.0'), undefined);
  assert.equal(fixedFor(last, 'p', '2.0.0'), '2.1.0');
});

test('a version named only in the explicit versions list does not erase the fix known from the ranges', async () => {
  const both = {
    id: 'GHSA-both',
    affected: [{ package: { ecosystem: 'npm', name: 'p' }, versions: ['1.0.0'], ranges: [{ type: 'SEMVER', events: [{ introduced: '1.1.0' }, { fixed: '1.3.0' }] }] }],
  };
  const { findings } = await scanFloor('^1.0.0', [both]);
  const f = findings.find((x) => x.kind === 'vuln')!;
  assert.match(f.message, /which allows affected 1\.0\.0, 1\.1\.0, 1\.2\.0\)/);
  assert.match(f.message, /Fixed in 1\.3\.0/);
});

test('an affected allowed version in a last_affected range leaves the Advisory without a fixed version', async () => {
  const last = { id: 'GHSA-last', affected: range([{ introduced: '0' }, { fixed: '1.1.0' }, { introduced: '1.2.0' }, { last_affected: '1.2.0' }]) };
  const { findings } = await scanFloor('^1.0.0', [last]);
  const f = findings.find((x) => x.kind === 'vuln')!;
  assert.match(f.message, /which allows affected 1\.0\.0, 1\.2\.0\)/);
  assert.match(f.message, /No fixed version known/);
});
