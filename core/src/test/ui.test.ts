import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCompat, findCompanion, formatReport } from '../updates/compat';
import { addSorted, locateKeys, removeDependency } from '../manifest/pkgEdit';
import { normalizeRepo, sliceChangelog, tagVersion } from '../changelog/repo';
import { isRange, satisfies } from '../utils/satisfies';

test('satisfies: caret, tilde, x-ranges, comparators, hyphen, ||, prerelease', () => {
  const yes: [string, string][] = [
    ['4.18.1', '^4.17.0'], ['0.2.5', '^0.2.3'], ['1.2.9', '~1.2.3'], ['1.9.0', '1.x'], ['1.2.3', '1.2.3'],
    ['11.2.3', '^10 || ^11'], ['2.0.0', '>=1.0.0 <3'], ['2.0.0', '>= 1.0.0'], ['1.5.0', '1.2.3 - 2.0.0'], ['3.0.0', '*'],
    ['5.9.9', '<6'], ['18.3.1', '^18.2.0'], ['1.2.3-beta.2', '>=1.2.3-beta.1'],
  ];
  const no: [string, string][] = [
    ['5.0.0', '^4.17.0'], ['0.3.0', '^0.2.3'], ['1.3.0', '~1.2.3'], ['2.0.0', '1.x'], ['12.0.0', '^10 || ^11'],
    ['3.0.1', '>=1.0.0 <3'], ['2.0.1', '1.2.3 - 2.0.0'], ['6.0.0', '<6'], ['1.2.3-beta.2', '^1.0.0'], ['1.0.0', 'not a range'],
    ['0.0.4', '^0.0.3'],
  ];
  for (const [v, r] of yes) assert.equal(satisfies(v, r), true, `${v} should satisfy ${r}`);
  for (const [v, r] of no) assert.equal(satisfies(v, r), false, `${v} should not satisfy ${r}`);
  assert.equal(isRange('^1.2.3 || >=4'), true);
  assert.equal(isRange('github:foo/bar'), false);
});

test('checkCompat: peers, node engines, dependents with companion updates', () => {
  const installed: Record<string, string> = { '@nestjs/core': '11.2.3', rxjs: '7.8.2', typescript: '6.0.3' };
  const r = checkCompat({
    name: '@nestjs/common',
    installed: '11.2.3',
    target: '12.2.0',
    current: { dependencies: { tslib: '2' } },
    next: {
      peerDependencies: { '@nestjs/core': '^12.0.0', rxjs: '^7.1.0', 'class-validator': '*' },
      peerDependenciesMeta: { 'class-validator': { optional: true } },
      engines: { node: '>=22' },
      dependencies: { tslib: '2', uid: '2' },
    },
    installedOf: (d) => installed[d],
    projectNode: '>=20.0.0',
    dependents: [
      { name: '@nestjs/jwt', version: '11.0.2', peerRange: '^10.0.0 || ^11.0.0', fixedBy: '12.0.3' },
      { name: 'old-lib', version: '1.0.0', peerRange: '^11.0.0' },
      { name: 'fine-lib', version: '2.0.0', peerRange: '>=11' },
    ],
  });
  const text = r.issues.map((x) => `${x.level}:${x.text}`).join('\n');
  assert.match(text, /error:needs peer @nestjs\/core \^12\.0\.0, but 11\.2\.3 is installed/);
  assert.doesNotMatch(text, /rxjs/);
  assert.doesNotMatch(text, /class-validator/); // optional and not installed
  assert.match(text, /warn:requires Node >=22/);
  assert.match(text, /info:dependencies: adds 1 \(uid\)/);
  assert.match(text, /error:@nestjs\/jwt@11\.0\.2 .*update @nestjs\/jwt to 12\.0\.3/);
  assert.match(text, /error:old-lib@1\.0\.0 .*no newer old-lib accepts/);
  assert.doesNotMatch(text, /fine-lib/);
  assert.deepEqual(r.companions.map((c) => `${c.name} ${c.from}->${c.to}`), ['@nestjs/jwt 11.0.2->12.0.3']);
  assert.match(formatReport('@nestjs/common', '11.2.3', '12.2.0', r), /Companion updates:/);
  assert.match(formatReport('x', '1.0.0', '1.0.1', { issues: [], companions: [] }), /No compatibility problems/);
});

test('findCompanion: newest version accepting the target, newer than current', () => {
  const manifests = {
    '11.0.2': { peerDependencies: { '@nestjs/common': '^10 || ^11' } },
    '12.0.0': { peerDependencies: { '@nestjs/common': '^12.0.0' } },
    '12.0.3': { peerDependencies: { '@nestjs/common': '^12.0.0' } },
    '13.0.0-beta.1': { peerDependencies: { '@nestjs/common': '^12 || ^13' } },
  };
  const versions = Object.keys(manifests);
  assert.equal(findCompanion(versions, manifests, '@nestjs/common', '12.2.0', '11.0.2'), '12.0.3');
  assert.equal(findCompanion(versions, manifests, '@nestjs/common', '14.0.0', '11.0.2'), undefined);
});

test('normalizeRepo / tagVersion / sliceChangelog', () => {
  const lodash = normalizeRepo('git+https://github.com/lodash/lodash.git')!;
  assert.equal(lodash.url, 'https://github.com/lodash/lodash');
  assert.equal(lodash.owner, 'lodash');
  assert.equal(normalizeRepo('github:a/b')!.url, 'https://github.com/a/b');
  assert.equal(normalizeRepo('git@github.com:a/b.git')!.url, 'https://github.com/a/b');
  assert.equal(normalizeRepo({ url: 'git://github.com/nestjs/nest.git', directory: 'packages/common' })!.directory, 'packages/common');
  assert.equal(normalizeRepo('https://gitlab.com/x/y.git')!.url, 'https://gitlab.com/x/y');
  assert.equal(normalizeRepo('nonsense'), null);
  assert.equal(tagVersion('v1.2.3'), '1.2.3');
  assert.equal(tagVersion('@nestjs/common@11.2.3'), '11.2.3');
  assert.equal(tagVersion('release'), null);
  const md = '# Changelog\n\n## [2.0.0] - 2025\n- breaking\n\n## 1.5.0\n- feature\n\n## 1.0.0\n- first\n';
  const s = sliceChangelog(md, '1.0.0', '2.0.0')!;
  assert.ok(s.includes('2.0.0') && s.includes('1.5.0') && !s.includes('first'));
  assert.equal(sliceChangelog(md, '2.0.0', '3.0.0'), null);
});

test('package.json editing helpers: remove, sorted add, locate script keys', () => {
  const t = '{\n  "scripts": {\n    "build": "echo \\"x\\" && tsc",\n    "dev": "vite"\n  },\n  "dependencies": {\n    "b": "1.0.0"\n  }\n}\n';
  assert.deepEqual(locateKeys(t, 'scripts'), [{ key: 'build', line: 2 }, { key: 'dev', line: 3 }]);
  const added = addSorted(t, 'dependencies', 'a', '^2.0.0');
  assert.deepEqual(Object.keys(JSON.parse(added).dependencies), ['a', 'b']);
  const removed = removeDependency(t, 'b');
  assert.equal('dependencies' in JSON.parse(removed), false);
  assert.ok(removed.endsWith('}\n'));
});
