import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixEffect, rangeEdits, replaceAll } from '../fixes/fixes';
import { locateDeps } from '../manifest/packageJson';
import { handle } from '../server/server';

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
