// Override audit (#35): which `resolutions` / `overrides` entries are still needed, redundant, forcing another major, or unused.
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeOverride, overrideKeys, requestsFor } from '../analysis/overrides';
import { LockRequest } from '../sources/lockfile';
import { PackageManager } from '../types';

const yarn: PackageManager = { name: 'yarn', installCmd: 'yarn install', overrideSection: 'resolutions' };
const npm: PackageManager = { name: 'npm', installCmd: 'npm install', overrideSection: 'overrides' };
const pnpm: PackageManager = { name: 'pnpm', installCmd: 'pnpm install', overrideSection: 'pnpm.overrides' };

const JS_YAML = ['3.13.1', '3.14.2', '3.15.2', '4.1.0', '4.3.2', '5.3.0', '5.4.1', '5.5.0'];

test('a js-yaml ^5 override over requests for ^3.13.1 and ^4.1.0 forces another major', () => {
  const row = judgeOverride({
    key: 'js-yaml',
    name: 'js-yaml',
    value: '^5.4.1',
    requests: [
      { range: '^3.13.1', by: ['@istanbuljs/load-nyc-config'] },
      { range: '^4.1.0', by: ['cosmiconfig'] },
      { range: '^5.4.1', by: [''] }, // the resolution's own lockfile key
    ],
    versions: JS_YAML,
    advisories: new Map(),
  });
  assert.equal(row.verdict, 'forces-other-major');
  assert.equal(row.forced, '5.5.0');
  assert.deepEqual(
    row.requests.map((q) => [q.range, q.fresh, q.otherMajor]),
    [
      ['^3.13.1', '3.15.2', true],
      ['^4.1.0', '4.3.2', true],
    ],
  );
});

test('forcing another major wins over an Advisory on a request in the same major', () => {
  const row = judgeOverride({
    key: 'js-yaml',
    name: 'js-yaml',
    value: '^5.4.1',
    requests: [
      { range: '^3.13.1', by: ['a'] },
      { range: '5.3.0', by: ['@nestjs/swagger'] },
    ],
    versions: JS_YAML,
    advisories: new Map([['5.3.0', ['GHSA-yaml']]]),
  });
  assert.equal(row.verdict, 'forces-other-major');
  assert.deepEqual(row.requests.find((q) => q.range === '5.3.0')?.advisories, ['GHSA-yaml']);
});

test('still needed when a requester would get a version with an Advisory, even across majors', () => {
  const row = judgeOverride({
    key: 'uuid',
    name: 'uuid',
    value: '^11.1.1',
    requests: [{ range: '^8.3.0', by: ['exceljs'] }],
    versions: ['8.3.0', '8.3.2', '11.1.0', '11.1.1'],
    advisories: new Map([['8.3.2', ['GHSA-uuid']]]),
  });
  assert.equal(row.verdict, 'still-needed');
  assert.deepEqual(row.requests[0], { range: '^8.3.0', by: ['exceljs'], fresh: '8.3.2', advisories: ['GHSA-uuid'], otherMajor: true });
});

test('redundant when every requester would get a clean version on its own', () => {
  const row = judgeOverride({
    key: 'body-parser',
    name: 'body-parser',
    value: '^2.4.0',
    requests: [{ range: '^2.2.1', by: ['express'] }],
    versions: ['2.2.1', '2.3.0', '2.4.0'],
    advisories: new Map([['2.2.1', ['GHSA-old']]]),
  });
  assert.equal(row.verdict, 'redundant');
  assert.equal(row.requests[0].fresh, '2.4.0');
});

test('unused when nothing in the lockfile requests the package; not checked when a lookup failed', () => {
  const base = { key: 'gone', name: 'gone', value: '^1.0.0', versions: ['1.0.0'], advisories: new Map<string, string[]>() };
  assert.equal(judgeOverride({ ...base, requests: [] }).verdict, 'unused');
  // requested only at the override's own range: the override changes nothing
  assert.equal(judgeOverride({ ...base, requests: [{ range: '^1.0.0', by: [''] }] }).verdict, 'redundant');
  const req = [{ range: '^0.9.0', by: ['x'] }];
  const noRegistry = judgeOverride({ ...base, requests: req, versions: undefined });
  assert.deepEqual([noRegistry.verdict, noRegistry.reason], ['not-checked', 'registry lookup failed']);
  const noOsv = judgeOverride({ ...base, requests: req, advisories: undefined });
  assert.deepEqual([noOsv.verdict, noOsv.reason], ['not-checked', 'advisory lookup failed']);
  const given = judgeOverride({ ...base, requests: req, notChecked: 'nested override' });
  assert.deepEqual([given.verdict, given.reason], ['not-checked', 'nested override']);
});

test('override keys: yarn scoped keys, npm nested objects and $references, pnpm', () => {
  const keys = overrideKeys({ resolutions: { 'js-yaml': '^5', '**/parent/minimatch': '^9.0.5', '@a/p/@b/c': '1.0.0', 'qs@^6.0.0': '6.14.0' } }, yarn);
  assert.deepEqual(
    keys.map((k) => [k.key, k.name, k.parent, k.keyRange, k.value]),
    [
      ['js-yaml', 'js-yaml', undefined, undefined, '^5'],
      ['**/parent/minimatch', 'minimatch', 'parent', undefined, '^9.0.5'],
      ['@a/p/@b/c', '@b/c', '@a/p', undefined, '1.0.0'],
      ['qs@^6.0.0', 'qs', undefined, '^6.0.0', '6.14.0'],
    ],
  );
  const n = overrideKeys({ dependencies: { foo: '^2.1.0' }, overrides: { foo: '$foo', bar: { '.': '1.0.0', baz: '2' } } }, npm);
  assert.equal(n.find((k) => k.name === 'foo')?.value, '^2.1.0');
  assert.match(n.find((k) => k.name === 'bar')?.notChecked ?? '', /nested/);
  assert.deepEqual(overrideKeys({ pnpm: { overrides: { 'a>b': '1' } } }, pnpm).map((k) => [k.name, k.parent]), [['b', 'a']]);
  assert.deepEqual(overrideKeys({}, yarn), []);
});

test('a scoped key only audits what its parent requests', () => {
  const reqs: LockRequest[] = [
    { name: 'minimatch', range: '^3.1.2', by: 'glob' },
    { name: 'minimatch', range: '^9.0.4', by: 'parent' },
    { name: 'minimatch', range: '^9.0.4', by: 'other' },
    { name: 'qs', range: '^6.0.0', by: 'a' },
    { name: 'qs', range: '6.11.0', by: 'b' },
  ];
  const [scoped, qs] = overrideKeys({ resolutions: { '**/parent/minimatch': '^9.0.5', 'qs@^6.0.0': '6.14.0' } }, yarn);
  assert.deepEqual(requestsFor(scoped, reqs), [{ range: '^9.0.4', by: ['parent'] }]);
  assert.deepEqual(requestsFor(qs, reqs), [{ range: '^6.0.0', by: ['a'] }]);
  const all = overrideKeys({ resolutions: { minimatch: '^9.0.5' } }, yarn)[0];
  assert.deepEqual(requestsFor(all, reqs), [
    { range: '^3.1.2', by: ['glob'] },
    { range: '^9.0.4', by: ['parent', 'other'] },
  ]);
});
