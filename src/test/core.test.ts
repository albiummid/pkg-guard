import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { attribute, parseNpmAudit, parseYarnAudit } from '../audit';
import { buildFindings } from '../findings';
import { buildNpmGraph, buildYarnGraph } from '../lockfile';
import { fixedFor } from '../osv';
import { addToSection, locateDeps } from '../packageJson';
import { pickAtLeast, suggest } from '../registry';
import { ScanResult, Settings } from '../scan';
import { baseVersion, compare, diffKind, prefixOf } from '../semver';
import { Vuln } from '../types';

const settings: Settings = {
  enableVulnerabilities: true, checkTransitive: true, enableOutdated: true, showMajorUpdates: true,
  minSeverity: 'low', auditFallback: true, registry: '', ignoredAdvisories: [], ignoredPackages: [],
};

test('semver compare / base / prefix / diff', () => {
  assert.ok(compare('4.18.1', '4.17.21') > 0);
  assert.ok(compare('1.0.0-beta.2', '1.0.0') < 0);
  assert.ok(compare('1.0.0-beta.10', '1.0.0-beta.2') > 0);
  assert.equal(baseVersion('^1.2.3'), '1.2.3');
  assert.equal(baseVersion('~1'), '1.0.0');
  assert.equal(baseVersion('latest'), null);
  assert.equal(baseVersion('workspace:*'), null);
  assert.equal(prefixOf('~2.0.0'), '~');
  assert.equal(prefixOf('2.0.0'), '');
  assert.equal(diffKind('1.2.3', '2.0.0'), 'major');
  assert.equal(diffKind('1.2.3', '1.3.0'), 'minor');
  assert.equal(diffKind('1.2.3', '1.2.4'), 'patch');
});

const PKG = `{
  "name": "x",
  "dependencies": {
    "lodash": "4.17.21",
    "@nestjs/core": "^11.0.0"
  },
  "scripts": { "a": "b" },
  "devDependencies": { "jest": "30.0.0" },
  "resolutions": {
    "uuid": "^11.1.1"
  }
}
`;

test('locateDeps finds entries with exact columns and ignores other sections', () => {
  const e = locateDeps(PKG);
  assert.deepEqual(e.map((x) => x.name), ['lodash', '@nestjs/core']);
  const lodash = e[0];
  const line = PKG.split('\n')[lodash.line];
  assert.equal(line.slice(lodash.versionStart, lodash.versionEnd), '4.17.21');
  assert.equal(line.slice(lodash.nameStart, lodash.end), '"lodash": "4.17.21"');
});

test('locateDeps handles a one-line section', () => {
  const t = '{\n  "devDependencies": { "jest": "30.0.0" }\n}\n';
  assert.equal(locateDeps(t).length, 0); // single-line sections are not located (no fix applied blindly)
});

test('addToSection keeps CRLF, indent and trailing newline', () => {
  const crlf = PKG.replace(/\n/g, '\r\n');
  const out = addToSection(crlf, 'resolutions', 'body-parser', '^2.4.0');
  assert.ok(out.includes('\r\n') && !/[^\r]\n/.test(out));
  assert.ok(out.endsWith('\r\n'));
  assert.ok(out.includes('    "body-parser": "^2.4.0"'));
  assert.equal(JSON.parse(out).resolutions['uuid'], '^11.1.1');
  const fresh = addToSection('{\n  "name": "x"\n}', 'overrides', 'a', '^1.0.0');
  assert.deepEqual(JSON.parse(fresh).overrides, { a: '^1.0.0' });
  assert.ok(!fresh.endsWith('\n'));
});

const YARN = `# yarn lockfile v1


"@nestjs/platform-express@11.2.3":
  version "11.2.3"
  dependencies:
    express "5.1.0"
    multer "2.2.0"

express@5.1.0:
  version "5.1.0"
  dependencies:
    body-parser "^2.2.0"

body-parser@^2.2.0:
  version "2.3.0"

multer@2.2.0:
  version "2.2.0"

lodash@4.17.21:
  version "4.17.21"
`;

const V = (pkg: string, version: string, extra: Partial<Vuln> = {}): Vuln => ({
  id: `GHSA-${pkg}`, url: `https://x/${pkg}`, summary: `${pkg} bad`, severity: 'high', pkg, version, ...extra,
});

test('yarn graph + attribution of transitive vulns to the direct dependency', () => {
  const g = buildYarnGraph(YARN, { '@nestjs/platform-express': '11.2.3', lodash: '4.17.21', multer: '2.2.0' })!;
  assert.equal(g.roots.size, 3);
  const vulns = new Map<string, Vuln[]>([
    ['body-parser@2.3.0', [V('body-parser', '2.3.0', { fixedIn: '2.4.0' })]],
    ['multer@2.2.0', [V('multer', '2.2.0', { fixedIn: '2.5.0' })]],
  ]);
  const hits = attribute(g, vulns);
  const bp = hits.find((h) => h.vuln.pkg === 'body-parser')!;
  assert.equal(bp.root, '@nestjs/platform-express');
  assert.deepEqual(bp.path, ['@nestjs/platform-express', 'express', 'body-parser']);
  // multer is itself a direct dependency, so it is reported once on its own line, not again under platform-express
  assert.deepEqual(hits.filter((h) => h.vuln.pkg === 'multer').map((h) => h.root), ['multer']);
});

test('npm lock v3 graph resolves nested node_modules', () => {
  const lock = {
    packages: {
      '': {},
      'node_modules/a': { version: '1.0.0', dependencies: { b: '^1' } },
      'node_modules/b': { version: '1.0.0' },
      'node_modules/a/node_modules/b': { version: '2.0.0' },
    },
  };
  const g = buildNpmGraph(lock, { a: '^1' })!;
  assert.deepEqual(g.nodes.get('node_modules/a')!.deps, ['node_modules/a/node_modules/b']);
});

test('fixedFor picks the fix of the range containing the version', () => {
  const affected = [{ package: { name: 'm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.5.0' }, { introduced: '2.0.0' }, { fixed: '2.3.0' }] }] }];
  assert.equal(fixedFor(affected, 'm', '1.2.0'), '1.5.0');
  assert.equal(fixedFor(affected, 'm', '2.1.0'), '2.3.0');
  assert.equal(fixedFor(affected, 'm', '3.0.0'), undefined);
});

test('registry suggestions stay in major, flag next major, and pick fixes in the right major', () => {
  const info = { latest: '5.0.0', versions: ['4.17.21', '4.18.0', '4.18.1', '5.0.0', '5.1.0-beta.1'], deprecated: {}, manifests: {} };
  assert.deepEqual(suggest('4.17.21', info), { inMajor: '4.18.1', nextMajor: '5.0.0' });
  assert.equal(pickAtLeast('4.18.0', '4.17.21', info), '4.18.1');
  assert.equal(pickAtLeast('4.18.0', '4.17.21', null), '4.18.0');
});

test('yarn/npm audit output parsing', () => {
  const line = JSON.stringify({ type: 'auditAdvisory', data: { resolution: { path: '@nestjs/platform-express>express>body-parser' }, advisory: { id: 1, github_advisory_id: 'GHSA-1', url: 'u', title: 't', severity: 'high', module_name: 'body-parser', patched_versions: '>=2.4.0', findings: [{ version: '2.3.0' }] } } });
  const h = parseYarnAudit(line + '\n{"type":"auditSummary"}')[0];
  assert.equal(h.root, '@nestjs/platform-express');
  assert.equal(h.vuln.fixedIn, '2.4.0');
  const npm = parseNpmAudit(JSON.stringify({ vulnerabilities: { express: { isDirect: true, via: ['body-parser'], effects: [] }, 'body-parser': { isDirect: false, via: [{ title: 't', url: 'https://github.com/advisories/GHSA-2', severity: 'high' }], effects: ['express'] } } }));
  assert.equal(npm[0].root, 'express');
  assert.equal(npm[0].vuln.id, 'GHSA-2');
});

test('buildFindings: direct vuln gets an update fix, transitive gets an override, outdated is informational', () => {
  const entries = locateDeps(PKG);
  const result: ScanResult = {
    entries,
    installed: new Map([['lodash', '4.17.21'], ['@nestjs/core', '11.0.0']]),
    hits: [
      { root: 'lodash', path: ['lodash'], vuln: V('lodash', '4.17.21', { fixedIn: '4.18.0' }) },
      { root: '@nestjs/core', path: ['@nestjs/core', 'path-to-regexp'], vuln: V('path-to-regexp', '8.0.0', { fixedIn: '8.2.0', severity: 'moderate' }) },
    ],
    info: new Map([['lodash', { latest: '4.18.1', versions: ['4.17.21', '4.18.0', '4.18.1'], deprecated: {}, manifests: {} }]]),
    lock: "yarn", pm: { name: "yarn", installCmd: "yarn install", overrideSection: "resolutions" },
    source: 'osv',
    notes: [],
  };
  const f = buildFindings(result, settings);
  const lodashVuln = f.find((x) => x.kind === 'vuln')!;
  assert.equal(lodashVuln.severity, 'error');
  assert.deepEqual(lodashVuln.fixes[0], { type: 'setVersion', range: '4.18.1', title: 'Update lodash to 4.18.1 (fixes 1 advisory)' });
  assert.match(lodashVuln.inline, /4\.18\.1/);
  const tr = f.find((x) => x.kind === 'transitive')!;
  assert.equal(tr.fixes[0].type, 'addOverride');
  assert.equal((tr.fixes[0] as any).section, 'resolutions');
  assert.equal(f.filter((x) => x.kind === 'outdated').length, 0); // the vuln fix already covers the in-major update
  const filtered = buildFindings({ ...result, hits: result.hits }, { ...settings, minSeverity: 'high', ignoredAdvisories: [] });
  assert.equal(filtered.filter((x) => x.kind === 'transitive').length, 0);
});

test('detectPm: lockfile, packageManager field, fallback; override section per manager', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const { detectPm } = require('../pm') as typeof import('../pm');
  const mk = (file?: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
    if (file) fs.writeFileSync(path.join(d, file), '');
    return d;
  };
  assert.equal(detectPm(mk('pnpm-lock.yaml')).overrideSection, 'pnpm.overrides');
  assert.equal(detectPm(mk('yarn.lock')).installCmd, 'yarn install');
  assert.equal(detectPm(mk('bun.lockb')).name, 'bun');
  assert.equal(detectPm(mk('package-lock.json')).overrideSection, 'overrides');
  assert.equal(detectPm(mk(), { packageManager: 'pnpm@9.1.0' }).name, 'pnpm');
  const nested = addToSection('{\n  "name": "x"\n}\n', 'pnpm.overrides', 'a', '^1.0.0');
  assert.deepEqual(JSON.parse(nested).pnpm, { overrides: { a: '^1.0.0' } });
});
