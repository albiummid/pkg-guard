import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importFindings } from '../imports/findings';
import { locateImports, packageName } from '../imports/locate';
import { locateDeps } from '../manifest/packageJson';
import { handle } from '../server';
import { Finding, ManifestFindings } from '../types';

test('packageName: bare, scoped and subpath specifiers; skips paths, protocols and aliases', () => {
  assert.equal(packageName('lodash'), 'lodash');
  assert.equal(packageName('lodash/fp'), 'lodash');
  assert.equal(packageName('@scope/pkg/sub/x.js'), '@scope/pkg');
  for (const s of ['./a', '../a', '/abs', 'node:fs', 'virtual:x', '@/components', '~/x', '#internal', '@scope']) assert.equal(packageName(s), undefined, s);
});

test('locateImports: import, export-from, require and dynamic import, with exact columns', () => {
  const src = [
    "import x from 'lodash';",
    'import "side-effect";',
    "import {",
    "  a,",
    "} from '@scope/pkg/sub';",
    "export * from 'reexp';",
    "const r = require('req'), d = await import(\"dyn\");",
    "import type { T } from 'types-only';",
    "import y from './local';",
  ].join('\n');
  const refs = locateImports(src);
  assert.deepEqual(refs.map((r) => r.name), ['lodash', 'side-effect', '@scope/pkg', 'reexp', 'req', 'dyn', 'types-only']);
  assert.deepEqual(refs[0], { name: 'lodash', line: 0, start: 14, end: 22 });
  assert.equal(refs[2].line, 4);
  assert.equal(src.split('\n')[6].slice(refs[5].start, refs[5].end), '"dyn"');
});

test('locateImports: ignores comments but not comment-like text in strings', () => {
  const src = [
    "// import a from 'commented';",
    "/* import b from 'block';",
    "   require('still-block') */ import c from 'after-block';",
    "import d from 'real'; // from 'trailing'",
    "const u = 'http://x'; require('kept');",
  ].join('\n');
  assert.deepEqual(locateImports(src).map((r) => r.name), ['after-block', 'real', 'kept']);
});

const ROOT = '{\n  "dependencies": {\n    "lodash": "^4.0.0",\n    "qs": "^6.0.0",\n    "zod": "^3.0.0"\n  }\n}\n';
const WS = '{\n  "dependencies": {\n    "lodash": "^4.17.21"\n  }\n}\n';

type Spec = Omit<Finding, 'entry' | 'fixes'> & { name: string };

function manifest(text: string, findings: Spec[]): ManifestFindings {
  const entries = locateDeps(text);
  return { entries, findings: findings.map(({ name, ...f }) => ({ ...f, entry: entries.find((e) => e.name === name)!, fixes: [] })) };
}

test('importFindings: vulnerability findings only, nearest manifest that declares the package wins', () => {
  const root = manifest(ROOT, [
    { name: 'lodash', kind: 'vuln', level: 'error', message: 'lodash vuln', inline: '⚠ 1 vuln', code: 'GHSA-1', url: 'u1' },
    { name: 'qs', kind: 'transitive', level: 'warning', message: 'qs transitive', inline: '⚠ side 1 vuln' },
    { name: 'qs', kind: 'vuln', level: 'error', message: 'qs vuln', inline: '⚠ 2 vulns', code: 'GHSA-2', url: 'u2' },
    { name: 'zod', kind: 'outdated', level: 'info', message: 'zod update', inline: '↑ 3.1.0' },
  ]);
  const ws = manifest(WS, []);
  const src = "import _ from 'lodash';\nimport qs from 'qs';\nimport { z } from 'zod';\n";
  const out = importFindings(src, [ws, root]);
  assert.equal(out.length, 1); // lodash resolves to the clean workspace copy, zod is only outdated
  assert.equal(out[0].ref.name, 'qs');
  assert.equal(out[0].level, 'error');
  assert.equal(out[0].message, 'qs vuln\n\nqs transitive');
  assert.equal(out[0].inline, '⚠ 2 vulns  ⚠ 1 vulnerable transitive dep');
  assert.equal(out[0].code, 'GHSA-2');

  assert.deepEqual(importFindings(src, [root]).map((f) => f.ref.name), ['lodash', 'qs']);
});

test('server: importFindings', async () => {
  const root = manifest(ROOT, [{ name: 'lodash', kind: 'vuln', level: 'warning', message: 'm', inline: 'i' }]);
  const r = JSON.parse(await handle(JSON.stringify({ id: 7, method: 'importFindings', params: { text: "require('lodash')", manifests: [root] } })));
  assert.equal(r.id, 7);
  assert.deepEqual(r.result[0].ref, { name: 'lodash', line: 0, start: 8, end: 16 });
});
