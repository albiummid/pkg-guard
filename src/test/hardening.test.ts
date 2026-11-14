// Behaviour tests for issue #1: vulnerability lookup that cannot silently miss, safer Fixes, tolerant manifest parsing.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { auditInvocation, parseNpmAudit, parseYarnAudit } from '../sources/audit';
import { buildFindings } from '../analysis/findings';
import { buildNpmGraph, buildYarnGraph } from '../sources/lockfile';
import { clearOsvCache, cvssScore, osvQuery, severityOf, toVuln } from '../sources/osv';
import { clearRegistryCache, fetchInfo } from '../sources/registry';
import { addToSection, locateDeps } from '../manifest/packageJson';
import { fixEffect, pinsEffect } from '../analysis/fixes';
import { scan } from '../analysis/scan';
import { ScanResult, Settings } from '../types';
import { Vuln } from '../types/index';

const settings: Settings = {
  enableVulnerabilities: true, checkTransitive: true, enableOutdated: true, showMajorUpdates: true, checkSync: true,
  minSeverity: 'low', auditFallback: true, registry: 'https://registry.example', ignoredAdvisories: [], ignoredPackages: [],
};
const offline: Settings = { ...settings, enableVulnerabilities: false, enableOutdated: false };

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pg-h-'));
const V = (pkg: string, version: string, extra: Partial<Vuln> = {}): Vuln => ({
  id: `GHSA-${pkg}`, url: `https://x/${pkg}`, summary: `${pkg} bad`, severity: 'high', pkg, version, ...extra,
});

/** Replaces global fetch for one test. */
async function withFetch<T>(impl: (url: string, init?: any) => Promise<Response> | Response, body: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => impl(String(url), init)) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = real;
  }
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

// ---------------------------------------------------------------- audit fallback

test('audit output that is not a complete report is a failed check, never an empty result', () => {
  assert.throws(() => parseNpmAudit('{"error":{"code":"ENOTFOUND","summary":"request failed"}}'));
  assert.throws(() => parseNpmAudit('{"advisories":{},"metadata":{}}'), /npm 7/);
  assert.throws(() => parseNpmAudit('not json'));
  assert.deepEqual(parseNpmAudit('{"auditReportVersion":2,"vulnerabilities":{}}'), []);
  assert.throws(() => parseYarnAudit('{"type":"info","data":"Network error"}\n'));
  assert.deepEqual(parseYarnAudit('{"type":"auditSummary","data":{}}\n'), []);
});

test('audit runs without a shell on POSIX and through cmd.exe with a constant command line on Windows', () => {
  assert.deepEqual(auditInvocation('npm', 'linux'), { file: 'npm', args: ['audit', '--json'] });
  assert.deepEqual(auditInvocation('yarn', 'darwin'), { file: 'yarn', args: ['audit', '--json'] });
  assert.deepEqual(auditInvocation('npm', 'win32'), { file: 'cmd.exe', args: ['/d', '/s', '/c', 'npm audit --json'] });
});

// ---------------------------------------------------------------- lockfile graphs

test('yarn alias entries are named after the real package', () => {
  const lock = `# yarn lockfile v1

"string-width-cjs@npm:string-width@^4.2.0":
  version "4.2.3"

"@scoped-alias@npm:@scope/real@^1.0.0":
  version "1.4.0"
`;
  const g = buildYarnGraph(lock, { 'string-width-cjs': 'npm:string-width@^4.2.0', '@scoped-alias': 'npm:@scope/real@^1.0.0' })!;
  assert.deepEqual([...g.nodes.values()].map((n) => n.name).sort(), ['@scope/real', 'string-width']);
  assert.equal(g.nodes.get(g.roots.get('string-width-cjs')!)!.name, 'string-width');
});

test('npm alias entries use the name recorded in the lockfile', () => {
  const lock = { packages: { '': {}, 'node_modules/string-width-cjs': { name: 'string-width', version: '4.2.3' } } };
  const g = buildNpmGraph(lock, { 'string-width-cjs': 'npm:string-width@^4' })!;
  assert.equal(g.nodes.get(g.roots.get('string-width-cjs')!)!.name, 'string-width');
});

test('npm workspace members resolve their own nested copy before the root copy', () => {
  const lock = {
    packages: {
      '': { workspaces: ['packages/*'] },
      'node_modules/lodash': { version: '4.17.21' },
      'packages/api': { name: 'api', version: '1.0.0' },
      'packages/api/node_modules/lodash': { version: '4.17.15' },
    },
  };
  const member = buildNpmGraph(lock, { lodash: '^4' }, 'packages/api')!;
  assert.equal(member.nodes.get(member.roots.get('lodash')!)!.version, '4.17.15');
  const root = buildNpmGraph(lock, { lodash: '^4' })!;
  assert.equal(root.nodes.get(root.roots.get('lodash')!)!.version, '4.17.21');
  const other = buildNpmGraph(lock, { lodash: '^4' }, 'packages/web')!; // no nested copy: falls back to the root
  assert.equal(other.nodes.get(other.roots.get('lodash')!)!.version, '4.17.21');
});

test('npm graph follows peer dependencies that npm installed', () => {
  const lock = {
    packages: {
      '': {},
      'node_modules/a': { version: '1.0.0', peerDependencies: { b: '^1' } },
      'node_modules/b': { version: '1.2.0' },
    },
  };
  const g = buildNpmGraph(lock, { a: '^1' })!;
  assert.deepEqual(g.nodes.get('node_modules/a')!.deps, ['node_modules/b']);
});

// ---------------------------------------------------------------- severity and aliases

test('severity: rated value first, malware is critical, CVSS v3 vectors are scored', () => {
  assert.equal(severityOf({ id: 'GHSA-1', database_specific: { severity: 'MODERATE' } }), 'moderate');
  assert.equal(severityOf({ id: 'MAL-2024-1' }), 'critical');
  assert.equal(severityOf({ id: 'GHSA-2', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] }), 'critical');
  assert.equal(severityOf({ id: 'GHSA-3', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N' }] }), 'moderate');
  assert.equal(severityOf({ id: 'GHSA-4' }), 'unknown');
  assert.equal(severityOf({ id: 'GHSA-5', severity: [{ type: 'CVSS_V4', score: 'CVSS:4.0/AV:N' }] }), 'unknown');
  assert.equal(cvssScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H'), 10);
  assert.equal(cvssScore('garbage'), undefined);
});

test('toVuln keeps the advisory aliases', () => {
  assert.deepEqual(toVuln({ id: 'GHSA-x', aliases: ['CVE-2024-1'] }, 'p', '1.0.0').aliases, ['CVE-2024-1']);
});

// ---------------------------------------------------------------- OSV lookup

const OSV_ID_RESPONSE = { results: [{ vulns: [{ id: 'GHSA-aaa' }] }] };
const DETAIL = { id: 'GHSA-aaa', database_specific: { severity: 'HIGH' }, affected: [{ package: { name: 'p' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.1.0' }] }] }] };

test('a failed advisory detail request is retried by the next scan instead of cached as unknown', async () => {
  clearOsvCache();
  let detailCalls = 0;
  await withFetch(
    (url) => {
      if (url.endsWith('/querybatch')) return json(OSV_ID_RESPONSE);
      detailCalls++;
      return detailCalls === 1 ? json({}, 503) : json(DETAIL);
    },
    async () => {
      const first = (await osvQuery([{ name: 'p', version: '1.0.0' }])).get('p@1.0.0')!;
      assert.equal(first[0].severity, 'unknown');
      const second = (await osvQuery([{ name: 'p', version: '1.0.0' }])).get('p@1.0.0')!;
      assert.equal(second[0].severity, 'high');
      assert.equal(second[0].fixedIn, '1.1.0');
    },
  );
});

test('concurrent scans share one OSV request for the same package', async () => {
  clearOsvCache();
  let batches = 0;
  await withFetch(
    (url) => {
      if (url.endsWith('/querybatch')) {
        batches++;
        return json(OSV_ID_RESPONSE);
      }
      return json(DETAIL);
    },
    async () => {
      const q = { name: 'p', version: '1.0.0' };
      const [a, b] = await Promise.all([osvQuery([q]), osvQuery([q])]);
      assert.equal(batches, 1);
      assert.equal(a.get('p@1.0.0')!.length, 1);
      assert.equal(b.get('p@1.0.0')!.length, 1);
    },
  );
});

test('paged OSV results are followed to the end', async () => {
  clearOsvCache();
  const pages: unknown[] = [];
  await withFetch(
    (url, init) => {
      if (url.endsWith('/querybatch')) {
        const body = JSON.parse(init.body);
        pages.push(body.queries[0].page_token ?? null);
        return body.queries[0].page_token
          ? json({ results: [{ vulns: [{ id: 'GHSA-bbb' }] }] })
          : json({ results: [{ vulns: [{ id: 'GHSA-aaa' }], next_page_token: 'T2' }] });
      }
      return json({ ...DETAIL, id: url.split('/').pop() });
    },
    async () => {
      const out = (await osvQuery([{ name: 'p', version: '1.0.0' }])).get('p@1.0.0')!;
      assert.deepEqual(out.map((v) => v.id).sort(), ['GHSA-aaa', 'GHSA-bbb']);
      assert.deepEqual(pages, [null, 'T2']);
    },
  );
});

test('a transient registry failure is retried soon while a missing package is remembered', async () => {
  clearRegistryCache();
  let calls = 0;
  await withFetch(
    () => {
      calls++;
      return calls === 1 ? json({}, 429) : json({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } });
    },
    async () => {
      assert.equal(await fetchInfo('flaky', 'https://registry.example'), null);
      assert.equal(await fetchInfo('flaky', 'https://registry.example'), null); // still inside the short back-off
      assert.equal(calls, 1);
      clearRegistryCache();
      assert.equal((await fetchInfo('flaky', 'https://registry.example'))!.latest, '1.0.0');
    },
  );
  clearRegistryCache();
  let notFound = 0;
  await withFetch(
    () => {
      notFound++;
      return json({}, 404);
    },
    async () => {
      await fetchInfo('ghost', 'https://registry.example');
      await fetchInfo('ghost', 'https://registry.example');
      assert.equal(notFound, 1);
    },
  );
});

// ---------------------------------------------------------------- findings

const PKG = '{\n  "dependencies": {\n    "p": "^1.0.0"\n  }\n}\n';
function result(over: Partial<ScanResult> = {}): ScanResult {
  return {
    entries: locateDeps(PKG), installed: new Map([['p', '1.0.0']]), installedFrom: new Map([['p', 'lock']]),
    hits: [], info: new Map(), lock: 'npm',
    pm: { name: 'npm', installCmd: 'npm install', overrideSection: 'overrides' },
    source: 'osv', notes: [], ...over,
  };
}

test('advisories of unknown severity are never removed by the minimum severity', () => {
  const r = result({ hits: [{ root: 'p', path: ['p'], vuln: V('p', '1.0.0', { severity: 'unknown' }) }] });
  assert.equal(buildFindings(r, { ...settings, minSeverity: 'critical' }).filter((f) => f.kind === 'vuln').length, 1);
  const rated = result({ hits: [{ root: 'p', path: ['p'], vuln: V('p', '1.0.0', { severity: 'low' }) }] });
  assert.equal(buildFindings(rated, { ...settings, minSeverity: 'high' }).filter((f) => f.kind === 'vuln').length, 0);
});

test('an advisory can be ignored by any of its aliases', () => {
  const r = result({ hits: [{ root: 'p', path: ['p'], vuln: V('p', '1.0.0', { aliases: ['CVE-2024-9'] }) }] });
  assert.equal(buildFindings(r, { ...settings, ignoredAdvisories: ['CVE-2024-9'] }).filter((f) => f.kind === 'vuln').length, 0);
  assert.equal(buildFindings(r, { ...settings, ignoredAdvisories: ['CVE-0000-0'] }).filter((f) => f.kind === 'vuln').length, 1);
});

test('a vulnerability found against a guessed floor version says it may apply', () => {
  const hits = [{ root: 'p', path: ['p'], vuln: V('p', '1.0.0') }];
  const guessed = buildFindings(result({ hits, installedFrom: new Map([['p', 'floor']]) }), settings).find((f) => f.kind === 'vuln')!;
  assert.match(guessed.message, /may be vulnerable/);
  const confirmed = buildFindings(result({ hits }), settings).find((f) => f.kind === 'vuln')!;
  assert.doesNotMatch(confirmed.message, /may be vulnerable/);
});

test('an update title counts only the advisories its version fixes', () => {
  const hits = [
    { root: 'p', path: ['p'], vuln: V('p', '1.0.0', { id: 'A', fixedIn: '1.1.0' }) },
    { root: 'p', path: ['p'], vuln: V('p', '1.0.0', { id: 'B' }) },
  ];
  const f = buildFindings(result({ hits }), settings).find((x) => x.kind === 'vuln')!;
  assert.equal(f.fixes[0].type, 'setVersion');
  assert.match(f.fixes[0].title, /fixes 1 advisory\)/);
});

test('a dist-tag range is not reported as out of sync', () => {
  const text = '{\n  "dependencies": {\n    "react": "canary"\n  }\n}\n';
  const r = result({ entries: locateDeps(text), installed: new Map([['react', '19.0.0']]), installedFrom: new Map([['react', 'lock']]), onDisk: new Map([['react', '19.0.0']]), hasNodeModules: true });
  assert.equal(buildFindings(r, settings).filter((f) => f.kind === 'unsynced').length, 0);
});

test('a range with a pinned major keeps its operator in the update', () => {
  const text = '{\n  "dependencies": {\n    "p": ">=1.0.0"\n  }\n}\n';
  const hits = [{ root: 'p', path: ['p'], vuln: V('p', '1.0.0', { fixedIn: '1.2.0' }) }];
  const r = result({ entries: locateDeps(text), hits });
  const f = buildFindings(r, settings).find((x) => x.kind === 'vuln')!;
  assert.equal((f.fixes[0] as any).range, '>=1.2.0');
});

const TRANSITIVE_PKG = '{\n  "dependencies": {\n    "express": "^4.0.0",\n    "debug": "^4.0.0"\n  }\n}\n';
function transitive(copies: Record<string, string[]>, over: Partial<ScanResult> = {}): ScanResult {
  return {
    entries: locateDeps(TRANSITIVE_PKG),
    installed: new Map([['express', '4.0.0'], ['debug', '4.1.0']]),
    installedFrom: new Map([['express', 'lock'], ['debug', 'lock']]),
    hits: [{ root: 'express', path: ['express', 'qs'], vuln: V('qs', '6.0.0', { fixedIn: '6.0.4' }) }],
    info: new Map(), lock: 'npm', copies: new Map(Object.entries(copies)),
    pm: { name: 'npm', installCmd: 'npm install', overrideSection: 'overrides' },
    source: 'osv', notes: [], ...over,
  };
}

test('a pin is offered for a single-copy transitive package', () => {
  const f = buildFindings(transitive({ qs: ['6.0.0'] }), settings).find((x) => x.kind === 'transitive')!;
  assert.ok(f.fixes.some((x) => x.type === 'addOverride'));
});

test('a pin is not offered when it would force other majors of the same package together', () => {
  const f = buildFindings(transitive({ qs: ['6.0.0', '2.3.0'] }), settings).find((x) => x.kind === 'transitive')!;
  assert.ok(!f.fixes.some((x) => x.type === 'addOverride'));
});

test('a pin is not offered when the package is also a direct dependency the pin would not satisfy', () => {
  const text = '{\n  "dependencies": {\n    "express": "^4.0.0",\n    "qs": "^5.0.0"\n  }\n}\n';
  const f = buildFindings(transitive({ qs: ['6.0.0'] }, { entries: locateDeps(text), installed: new Map([['express', '4.0.0'], ['qs', '5.1.0']]), installedFrom: new Map([['express', 'lock'], ['qs', 'lock']]) }), settings).find((x) => x.kind === 'transitive')!;
  assert.ok(!f.fixes.some((x) => x.type === 'addOverride'));
});

test('a pin is not offered when the root manifest it is written to declares the package', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'yarn.lock'), '# yarn lockfile v1\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{\n  "name": "root",\n  "dependencies": { "qs": "^5.0.0" }\n}\n');
  const member = path.join(root, 'packages', 'api');
  fs.mkdirSync(member, { recursive: true });
  const scanned = await scan(TRANSITIVE_PKG, path.join(member, 'package.json'), offline);
  assert.ok(scanned.rootDeclared?.has('qs'));
  assert.ok(!scanned.rootDeclared?.has('express'));
  const f = buildFindings(transitive({ qs: ['6.0.0'] }, { rootDeclared: scanned.rootDeclared }), settings).find((x) => x.kind === 'transitive')!;
  assert.ok(!f.fixes.some((x) => x.type === 'addOverride'));
  // the same finding without a declaring root still offers the pin
  const free = buildFindings(transitive({ qs: ['6.0.0'] }), settings).find((x) => x.kind === 'transitive')!;
  assert.ok(free.fixes.some((x) => x.type === 'addOverride'));
});

// ---------------------------------------------------------------- manifest parsing and editing

test('dependencies are located in compact, single-line and unusually laid-out manifests', () => {
  const compact = '{"name":"x","dependencies":{"a":"^1.0.0","b":"2.0.0"},"devDependencies":{"c":"~3.0.0"}}';
  const e = locateDeps(compact);
  assert.deepEqual(e.map((x) => [x.name, x.range, x.section]), [['a', '^1.0.0', 'dependencies'], ['b', '2.0.0', 'dependencies'], ['c', '~3.0.0', 'devDependencies']]);
  for (const x of e) assert.equal(compact.slice(x.versionStart, x.versionEnd), x.range);
  const spaced = '{\n  "devDependencies"\n  :\n  {\n    "jest": "30.0.0"\n  }\n}';
  assert.equal(locateDeps(spaced).length, 1);
  assert.equal(locateDeps(spaced)[0].line, 4);
});

test('nested keys that only look like a dependency section are ignored', () => {
  const text = '{\n  "pnpm": {\n    "overrides": { "dependencies": { "x": "1.0.0" } }\n  },\n  "dependencies": {\n    "a": "1.0.0"\n  }\n}';
  assert.deepEqual(locateDeps(text).map((x) => x.name), ['a']);
});

test('adding a pin changes only that entry and keeps the rest of the file byte for byte', () => {
  const text = '{\n  "name": "x",\n  "files": ["a", "b"],\n  "overrides": {\n    "foo": "1.0.0"\n  },\n  "keywords": ["k"]\n}\n';
  const out = addToSection(text, 'overrides', 'qs', '^6.0.4');
  assert.equal(out, '{\n  "name": "x",\n  "files": ["a", "b"],\n  "overrides": {\n    "foo": "1.0.0",\n    "qs": "^6.0.4"\n  },\n  "keywords": ["k"]\n}\n');
  const replaced = addToSection(out, 'overrides', 'foo', '2.0.0');
  assert.ok(replaced.includes('"foo": "2.0.0"') && replaced.includes('"files": ["a", "b"]'));
});

test('adding a pin to a new section appends it with the file indent', () => {
  const out = addToSection('{\n    "name": "x"\n}\n', 'resolutions', 'qs', '^6.0.4');
  assert.deepEqual(JSON.parse(out), { name: 'x', resolutions: { qs: '^6.0.4' } });
  assert.ok(out.includes('\n    "resolutions": {\n        "qs": "^6.0.4"\n    }\n}'));
});

test('a pin keeps an existing nested npm override instead of replacing it', () => {
  const text = '{\n  "overrides": {\n    "qs": { ".": "6.0.0", "deep": "1.0.0" }\n  }\n}\n';
  const out = JSON.parse(addToSection(text, 'overrides', 'qs', '^6.0.4'));
  assert.deepEqual(out.overrides.qs, { '.': '^6.0.4', deep: '1.0.0' });
});

// ---------------------------------------------------------------- scan

test('scan: a pnpm or bun lockfile produces a note that transitive checks are off', async () => {
  for (const lockfile of ['pnpm-lock.yaml', 'bun.lock']) {
    const d = tmp();
    fs.writeFileSync(path.join(d, lockfile), '');
    const r = await scan(PKG, path.join(d, 'package.json'), offline);
    assert.ok(r.notes.some((n) => n.includes(lockfile) && /transitive/i.test(n)), `${lockfile}: ${r.notes.join(' | ')}`);
  }
});

test('scan: the nearest lockfile wins over one in a parent folder', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'yarn.lock'), '# yarn lockfile v1\n\np@^1.0.0:\n  version "9.9.9"\n');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'pnpm-lock.yaml'), '');
  const r = await scan(PKG, path.join(proj, 'package.json'), offline);
  assert.notEqual(r.installed.get('p'), '9.9.9');
});

test('scan: dependencies that could not be located on a line are reported', async () => {
  const text = '{\n  "dependencies":\n  {\n    "a":\n      "^1.0.0"\n  }\n}';
  const r = await scan(text, path.join(tmp(), 'package.json'), offline);
  assert.ok(r.notes.some((n) => /could not be located/.test(n) && n.includes('a')), r.notes.join(' | '));
});

test('scan: dependencies with no known version are listed in a note', async () => {
  const text = '{\n  "dependencies": {\n    "tagged": "next",\n    "union": "^1.0.0 || ^2.0.0"\n  }\n}';
  const r = await scan(text, path.join(tmp(), 'package.json'), offline);
  assert.ok(r.notes.some((n) => /no version/i.test(n) && n.includes('tagged') && n.includes('union')), r.notes.join(' | '));
});

test('scan: an npm workspace member is checked against its own nested copy', async () => {
  const root = tmp();
  const member = path.join(root, 'packages', 'api');
  fs.mkdirSync(member, { recursive: true });
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { workspaces: ['packages/*'] },
      'node_modules/lodash': { version: '4.17.21' },
      'packages/api': { name: 'api', version: '1.0.0' },
      'packages/api/node_modules/lodash': { version: '4.17.15' },
    },
  }));
  const text = '{\n  "name": "api",\n  "dependencies": {\n    "lodash": "^4.17.0"\n  }\n}\n';
  const r = await scan(text, path.join(member, 'package.json'), offline);
  assert.equal(r.installed.get('lodash'), '4.17.15');
});

test('scan: when OSV fails and the audit fallback is off, the check is reported as failed, not as clean', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/p': { version: '1.0.0' } } }));
  clearOsvCache();
  const r = await withFetch(
    () => {
      throw new Error('offline');
    },
    () => scan(PKG, path.join(d, 'package.json'), { ...settings, enableOutdated: false, auditFallback: false }),
  );
  assert.equal(r.source, 'none');
  assert.ok(r.notes.some((n) => /vulnerability check failed/.test(n)), r.notes.join(' | '));
});

// ---------------------------------------------------------------- sidecar protocol

test('server: a scan response lists only the versions newer than the installed one, newest first', async () => {
  const { handle } = require('../server') as typeof import('../server');
  clearRegistryCache();
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'node_modules', 'p'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'p', 'package.json'), '{"version":"1.2.0"}');
  const versions = Object.fromEntries(['1.0.0', '1.1.0', '1.2.0', '1.3.0', '2.0.0', '2.1.0-beta.1'].map((v) => [v, {}]));
  const reply = await withFetch(
    () => json({ 'dist-tags': { latest: '2.0.0' }, versions }),
    async () =>
      JSON.parse(await handle(JSON.stringify({ id: 1, method: 'scan', params: { text: PKG, pkgFile: path.join(dir, 'package.json'), settings: { ...settings, enableVulnerabilities: false } } }))),
  );
  assert.deepEqual(reply.result.newer.p, ['2.0.0', '1.3.0']);
});

// ---------------------------------------------------------------- pins target the manifest the package manager reads

test('fixEffect: a pin for a workspace member edits the root manifest', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'yarn.lock'), '# yarn lockfile v1\n');
  const rootPkg = '{\n  "name": "root",\n  "workspaces": ["packages/*"]\n}\n';
  fs.writeFileSync(path.join(root, 'package.json'), rootPkg);
  const member = path.join(root, 'packages', 'api');
  fs.mkdirSync(member, { recursive: true });
  const memberText = '{\n  "name": "api",\n  "dependencies": {\n    "express": "^4.0.0"\n  }\n}\n';
  const entry = locateDeps(memberText)[0];
  const fx = { type: 'addOverride' as const, title: 't', section: 'resolutions', name: 'qs', range: '^6.0.4' };
  const effect = fixEffect(memberText, entry, fx, path.join(member, 'package.json'));
  assert.equal(effect.type, 'edit');
  if (effect.type !== 'edit') return;
  assert.equal(effect.file, path.join(root, 'package.json'));
  assert.ok(effect.edits[0].newText.includes('"resolutions"'));
  const same = fixEffect(rootPkg, locateDeps(rootPkg)[0] ?? entry, fx, path.join(root, 'package.json'));
  assert.equal(same.type === 'edit' ? same.file : 'x', undefined); // the scanned manifest is the root: no redirect
});

test('pinsEffect: several pins land in the root manifest in one edit', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'yarn.lock'), '# yarn lockfile v1\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*'] }, null, 2) + '\n');
  const member = path.join(root, 'packages', 'api');
  fs.mkdirSync(member, { recursive: true });
  const effect = pinsEffect('{}', [
    { section: 'resolutions', name: 'qs', range: '^6.0.4' },
    { section: 'resolutions', name: 'ws', range: '^8.17.1' },
  ], path.join(member, 'package.json'));
  assert.equal(effect.type, 'edit');
  if (effect.type !== 'edit') return;
  assert.equal(effect.file, path.join(root, 'package.json'));
  assert.equal(effect.edits.length, 1);
  assert.ok(effect.edits[0].newText.includes('"qs"') && effect.edits[0].newText.includes('"ws"'));
});
