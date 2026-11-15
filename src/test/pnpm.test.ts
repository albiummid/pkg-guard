// Behaviour tests for issue #18: Transitive vulnerabilities from pnpm-lock.yaml, built from fixture lockfiles.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { attribute } from '../sources/audit';
import { buildPnpmGraph } from '../sources/pnpmLock';
import { pinTarget } from '../analysis/fixes';
import { scan } from '../analysis/scan';
import { Settings } from '../types';
import { Vuln } from '../types/index';

// compiled to dist/test, so the fixtures are read from the source tree
const FIXTURES = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'pnpm');
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, `${name}.yaml`), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pg-pnpm-'));
const offline: Settings = {
  enableVulnerabilities: false, checkTransitive: true, enableOutdated: false, showMajorUpdates: true, checkSync: true,
  minSeverity: 'low', auditFallback: false, registry: 'https://registry.example', ignoredAdvisories: [], ignoredPackages: [],
};
const vuln = (pkg: string, version: string): Vuln => ({ id: `GHSA-${pkg}`, url: 'https://x', summary: 'bad', severity: 'high', pkg, version });

/** The direct dependency and chain each vulnerable package is attributed to. */
function hitsFor(text: string, deps: Record<string, string>, bad: [string, string][], importer?: string) {
  const g = buildPnpmGraph(text, deps, importer)!;
  assert.ok(g, 'graph');
  return attribute(g, new Map(bad.map(([p, v]) => [`${p}@${v}`, [vuln(p, v)]]))).map((h) => ({ root: h.root, path: h.path.join('>') }));
}

const FORMATS: [string, Record<string, string>][] = [
  ['v5', { express: '^4.17.0', 'react-dom': '^18.0.0' }],
  ['v6', { express: '^4.17.0', 'cjs-width': 'npm:string-width@^4.2.0', vitest: '^1.0.0' }],
  ['v9', { express: '^4.17.0', 'cjs-width': 'npm:string-width@^4.2.0', vitest: '^1.0.0', shared: 'workspace:*' }],
];
for (const [name, deps] of FORMATS) {
  test(`pnpm ${name}: a Transitive vulnerability is attributed to the direct dependency that pulls it in`, () => {
    const hits = hitsFor(fixture(name), deps, [['qs', '6.7.0']]);
    assert.ok(hits.some((h) => h.root === 'express' && h.path === 'express>qs'), JSON.stringify(hits));
  });
}

test('pnpm v5: scoped packages, peer suffixes and a two-level chain resolve', () => {
  const hits = hitsFor(fixture('v5'), { 'react-dom': '^18.0.0' }, [['@scope/inner', '1.0.0'], ['mime-types', '2.1.35']]);
  assert.deepEqual(hits, [{ root: 'react-dom', path: 'react-dom>@scope/inner' }]);
  assert.deepEqual(hitsFor(fixture('v5'), { express: '^4' }, [['mime-types', '2.1.35']]), [{ root: 'express', path: 'express>accepts>mime-types' }]);
});

test('pnpm v6/v9: an aliased dependency is named after the package it installs; devDependencies and peer-suffixed packages resolve', () => {
  for (const name of ['v6', 'v9']) {
    const g = buildPnpmGraph(fixture(name), { 'cjs-width': 'npm:string-width@^4', vitest: '^1' })!;
    assert.equal(g.nodes.get(g.roots.get('cjs-width')!)?.name, 'string-width', name);
    const vitest = g.nodes.get(g.roots.get('vitest')!)!;
    assert.equal(vitest.version, '1.0.0', name);
    assert.ok(vitest.deps.includes('@types/node@20.0.0') && vitest.deps.includes('qs@6.7.0'), name);
  }
});

test('pnpm v9: workspace links are not registry packages', () => {
  const g = buildPnpmGraph(fixture('v9'), { shared: 'workspace:*', express: '^4' })!;
  assert.equal(g.roots.has('shared'), false);
  assert.equal(g.roots.has('express'), true);
});

test('pnpm workspace: each member is resolved from its own importer entry', () => {
  const text = fixture('workspace');
  const bad: [string, string][] = [['qs', '6.7.0']];
  assert.deepEqual(hitsFor(text, { express: '^4.17.0' }, bad, 'packages/api'), [{ root: 'express', path: 'express>qs' }]);
  assert.deepEqual(hitsFor(text, { express: '^4.18.0' }, bad, 'packages/web'), []);
  const web = buildPnpmGraph(text, { express: '^4.18.0' }, 'packages/web')!;
  assert.equal(web.nodes.get(web.roots.get('express')!)?.version, '4.18.2');
  assert.equal(buildPnpmGraph(text, { typescript: '^5' }, '.')!.roots.has('typescript'), true);
  assert.equal(buildPnpmGraph(text, { express: '^4' }, 'packages/missing')!.roots.size, 0);
});

test('pnpm: a file with no lockfileVersion is not a lockfile', () => {
  assert.equal(buildPnpmGraph('', { a: '1' }), null);
});

test('scan: a pnpm-lock.yaml gives Installed versions and no "not supported" note', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'pnpm-lock.yaml'), fixture('v9'));
  const pkg = '{\n  "name": "x",\n  "dependencies": {\n    "express": "^4.17.0"\n  }\n}\n';
  const r = await scan(pkg, path.join(d, 'package.json'), offline);
  assert.equal(r.lock, 'pnpm');
  assert.equal(r.installed.get('express'), '4.17.1');
  assert.deepEqual(r.copies?.get('qs'), ['6.7.0']);
  assert.ok(!r.notes.some((n) => /not supported/.test(n)), r.notes.join(' | '));
});

test('scan: a pnpm workspace member is resolved from its importer, and its Pin goes to the root manifest', async () => {
  const root = tmp();
  const member = path.join(root, 'packages', 'web');
  fs.mkdirSync(member, { recursive: true });
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), fixture('workspace'));
  fs.writeFileSync(path.join(root, 'package.json'), '{\n  "name": "root"\n}\n');
  const pkg = '{\n  "name": "web",\n  "dependencies": {\n    "express": "^4.18.0"\n  }\n}\n';
  const r = await scan(pkg, path.join(member, 'package.json'), offline);
  assert.equal(r.installed.get('express'), '4.18.2');
  assert.equal(r.pm.name, 'pnpm');
  assert.equal(r.pm.overrideSection, 'pnpm.overrides');
  assert.equal(pinTarget(path.join(member, 'package.json')), path.join(root, 'package.json'));
});
