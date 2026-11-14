import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixEffect, rangeEdits, replaceAll } from '../analysis/fixes';
import { locateDeps } from '../manifest/packageJson';
import { handle } from '../server';

const PKG = '{\n  "dependencies": {\n    "left-pad": "^1.0.0",\n    "zod": "3.1.0"\n  }\n}\n';

test('rangeEdits keeps the range prefix and skips unknown packages', () => {
  const edits = rangeEdits(PKG, [
    { name: 'left-pad', version: '1.3.0' },
    { name: 'zod', version: '3.2.0' },
    { name: 'missing', version: '1.0.0' },
  ]);
  assert.equal(edits.length, 2);
  assert.deepEqual(edits[0], { startLine: 2, startChar: 17, endLine: 2, endChar: 23, newText: '^1.3.0' });
  assert.equal(edits[1].newText, '3.2.0'); // exact pins stay exact
});

test('fixEffect: setVersion edits the version string, ignore fixes become settings', () => {
  const entry = locateDeps(PKG)[0];
  const set = fixEffect(PKG, entry, { type: 'setVersion', title: 't', range: '^1.3.0' });
  assert.equal(set.type, 'edit');
  assert.deepEqual(fixEffect(PKG, entry, { type: 'ignoreAdvisory', title: 't', id: 'GHSA-1' }), { type: 'setting', key: 'ignoredAdvisories', value: 'GHSA-1' });
  assert.deepEqual(fixEffect(PKG, entry, { type: 'ignorePackage', title: 't', name: 'x' }), { type: 'setting', key: 'ignoredPackages', value: 'x' });
});

test('fixEffect: addOverride rewrites the whole document', () => {
  const entry = locateDeps(PKG)[0];
  const r = fixEffect(PKG, entry, { type: 'addOverride', title: 't', section: 'overrides', name: 'qs', range: '^6.0.0' });
  assert.equal(r.type, 'edit');
  if (r.type !== 'edit') return;
  const [e] = r.edits;
  assert.deepEqual(e, { ...replaceAll(PKG, e.newText) });
  assert.equal(e.startLine, 0);
  assert.equal(e.endLine, 6);
  assert.deepEqual(JSON.parse(e.newText).overrides, { qs: '^6.0.0' });
});

test('server: ping, rangeEdits, errors keep the request id', async () => {
  assert.deepEqual(JSON.parse(await handle('{"id":1,"method":"ping"}')), { id: 1, result: 'pong' });
  const r = JSON.parse(await handle(JSON.stringify({ id: 2, method: 'rangeEdits', params: { text: PKG, updates: [{ name: 'zod', version: '3.2.0' }] } })));
  assert.equal(r.id, 2);
  assert.equal(r.result[0].newText, '3.2.0');
  assert.deepEqual(JSON.parse(await handle('{"id":3,"method":"nope"}')), { id: 3, error: 'unknown method: nope' });
  assert.equal(JSON.parse(await handle('not json')).id, null);
});

test('server: upgradeReport offline returns a report and markdown', async () => {
  const settings = { enableVulnerabilities: false, checkTransitive: false, enableOutdated: false, showMajorUpdates: false, minSeverity: 'low', auditFallback: false, registry: 'https://registry.npmjs.org', ignoredAdvisories: [], ignoredPackages: [] };
  const r = JSON.parse(await handle(JSON.stringify({ id: 5, method: 'upgradeReport', params: { text: PKG, pkgFile: 'D:/nowhere/package.json', settings } })));
  assert.equal(r.id, 5);
  assert.deepEqual(r.result.report.rows, []);
  assert.match(r.result.markdown, /^# Upgrade report/);
});

test('server: scan offline returns findings, installed versions and pm', async () => {
  const settings = { enableVulnerabilities: false, checkTransitive: false, enableOutdated: false, showMajorUpdates: false, minSeverity: 'low', auditFallback: false, registry: 'https://registry.npmjs.org', ignoredAdvisories: [], ignoredPackages: [] };
  const r = JSON.parse(await handle(JSON.stringify({ id: 4, method: 'scan', params: { text: PKG, pkgFile: 'D:/nowhere/package.json', settings } })));
  assert.equal(r.result.entries.length, 2);
  assert.equal(r.result.installed['left-pad'], '1.0.0');
  assert.deepEqual(r.result.findings, []);
  assert.equal(r.result.pm.name, 'npm');
});

const call = async (method: string, params: unknown) => JSON.parse(await handle(JSON.stringify({ id: 9, method, params })));
const apply = (text: string, e: { startLine: number; startChar: number; endLine: number; endChar: number; newText: string }) => {
  const lines = text.split('\n');
  const off = (l: number, c: number) => lines.slice(0, l).reduce((n, s) => n + s.length + 1, 0) + c;
  return text.slice(0, off(e.startLine, e.startChar)) + e.newText + text.slice(off(e.endLine, e.endChar));
};
const CRLF = '{\r\n  "dependencies": {\r\n    "b": "1.0.0"\r\n  },\r\n  "scripts": {\r\n    "build": "tsc",\r\n    "dev": "x"\r\n  }\r\n}\r\n';
const TAB = '{\n\t"devDependencies": {\n\t\t"b": "1.0.0"\n\t}\n}\n';

test('server: addDependencyEdits inserts sorted into the chosen section (CRLF, tab indent)', async () => {
  const r = await call('addDependencyEdits', { text: CRLF, section: 'dependencies', name: 'a', range: '^2.0.0' });
  assert.equal(r.id, 9);
  assert.equal(r.result.length, 1);
  const out = apply(CRLF, r.result[0]);
  assert.deepEqual(Object.keys(JSON.parse(out).dependencies), ['a', 'b']);
  assert.ok(out.includes('\r\n  "dependencies": {\r\n    "a": "^2.0.0",\r\n'));
  assert.ok(!/[^\r]\n/.test(out));
  const t = await call('addDependencyEdits', { text: TAB, section: 'devDependencies', name: 'a', range: '^1.0.0' });
  assert.equal(apply(TAB, t.result[0]), '{\n\t"devDependencies": {\n\t\t"a": "^1.0.0",\n\t\t"b": "1.0.0"\n\t}\n}\n');
});

test('server: removeDependencyEdits removes from every section and drops an emptied one', async () => {
  const r = await call('removeDependencyEdits', { text: CRLF, name: 'b' });
  const out = apply(CRLF, r.result[0]);
  assert.equal(JSON.parse(out).dependencies, undefined);
  assert.ok(out.startsWith('{\r\n  "scripts"'));
  const t = await call('removeDependencyEdits', { text: TAB, name: 'b' });
  assert.equal(apply(TAB, t.result[0]), '{}\n');
});

test('server: scriptLocations returns the line of each script', async () => {
  assert.deepEqual((await call('scriptLocations', { text: CRLF })).result, [{ key: 'build', line: 5 }, { key: 'dev', line: 6 }]);
  assert.deepEqual((await call('scriptLocations', { text: TAB })).result, []);
});
