import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { bumpTargets, newerVersions, previousVersion } from '../bump';

const versions = ['4.17.20', '4.17.21', '4.17.22', '4.17.23', '4.18.0', '4.18.1', '4.19.0-beta.1', '5.0.0', '5.1.0', '6.0.0-rc.1'];

test('bumpTargets: newest patch / minor / major from the installed version', () => {
  assert.deepEqual(bumpTargets('4.17.21', versions), { patch: '4.17.23', minor: '4.18.1', major: '5.1.0' });
  assert.deepEqual(bumpTargets('4.18.1', versions), { major: '5.1.0' });
  assert.deepEqual(bumpTargets('5.1.0', versions), {});
  assert.deepEqual(bumpTargets('4.18.0', versions), { patch: '4.18.1', major: '5.1.0' });
  assert.deepEqual(bumpTargets('garbage', versions), {});
});

test('newerVersions skips prereleases and older versions; previousVersion finds the predecessor', () => {
  assert.deepEqual(newerVersions('4.18.0', versions), ['5.1.0', '5.0.0', '4.18.1']);
  assert.equal(newerVersions(undefined, versions).length, 9 - 1 - 0); // all stable ones
  assert.equal(previousVersion('4.18.0', versions), '4.17.23');
  assert.equal(previousVersion('4.17.20', versions), undefined);
});
