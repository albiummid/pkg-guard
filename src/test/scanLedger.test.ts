import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScanLedger } from '../analysis/scanLedger';

test('scan ledger: an older scan never replaces a newer result', () => {
  const l = createScanLedger<string>();
  const a = l.begin('/p/package.json');
  const b = l.begin('/p/package.json');
  assert.equal(l.commit('/p/package.json', b, 'new'), true);
  assert.equal(l.commit('/p/package.json', a, 'old'), false);
  assert.equal(l.states.get('/p/package.json'), 'new');
});

test('scan ledger: retain forgets deleted manifests and keeps the others', () => {
  const l = createScanLedger<string>();
  for (const k of ['/a', '/b']) l.commit(k, l.begin(k), k);
  l.begin('/c'); // scan started, never finished
  const dropped = l.retain((k) => k === '/a');
  assert.deepEqual(dropped.sort(), ['/b', '/c']);
  assert.deepEqual([...l.states.keys()], ['/a']);
  assert.deepEqual(l.retain((k) => k === '/a'), []);
});

test('scan ledger: a file that comes back is scanned and stored afresh', () => {
  const l = createScanLedger<string>();
  l.commit('/a', l.begin('/a'), 'v1');
  l.commit('/a', l.begin('/a'), 'v2');
  assert.equal(l.forget('/a'), true);
  assert.equal(l.forget('/a'), false);
  const seq = l.begin('/a');
  assert.equal(seq, 1); // order restarts: nothing of the old file is remembered
  assert.equal(l.commit('/a', seq, 'back'), true);
  assert.equal(l.states.get('/a'), 'back');
});

test('scan ledger: cancel drops running scans but keeps the stored result', () => {
  const l = createScanLedger<string>();
  l.commit('/a', l.begin('/a'), 'v1');
  const running = l.begin('/a');
  l.cancel('/a');
  assert.equal(l.commit('/a', running, 'late'), false);
  assert.equal(l.states.get('/a'), 'v1');
});
