import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { createManifestLookup } from '../imports/manifestLookup';

/** Paths are written with '/' and resolved so the tests also run on Windows. */
const resolveAll = (...ps: string[]) => ps.map((p) => path.resolve(p));

function fakeFs(initial: string[]) {
  const files = new Set(resolveAll(...initial));
  let probes = 0;
  return { files, exists: (p: string) => (probes++, files.has(p)), probes: () => probes };
}

test('manifest lookup: repeated edits in one folder probe the file system once', () => {
  const fs = fakeFs(['/ws/pkg/package.json', '/ws/package.json']);
  const lookup = createManifestLookup(fs.exists);
  const [dir, top] = resolveAll('/ws/pkg/src', '/ws');
  assert.deepEqual(lookup.above(dir, top), resolveAll('/ws/pkg/package.json', '/ws/package.json'));
  const after = fs.probes();
  lookup.above(dir, top);
  lookup.above(dir, top);
  assert.equal(fs.probes(), after);
});

test('manifest lookup: invalidate makes a created or deleted package.json take effect', () => {
  const fs = fakeFs(['/ws/package.json']);
  const lookup = createManifestLookup(fs.exists);
  const [dir, top] = resolveAll('/ws/pkg/src', '/ws');
  assert.deepEqual(lookup.above(dir, top), resolveAll('/ws/package.json'));
  fs.files.add(path.resolve('/ws/pkg/package.json'));
  assert.deepEqual(lookup.above(dir, top), resolveAll('/ws/package.json'), 'stale until invalidated');
  lookup.invalidate();
  assert.deepEqual(lookup.above(dir, top), resolveAll('/ws/pkg/package.json', '/ws/package.json'));
  fs.files.delete(path.resolve('/ws/package.json'));
  lookup.invalidate();
  assert.deepEqual(lookup.above(dir, top), resolveAll('/ws/pkg/package.json'));
});

test('manifest lookup: stops at the top folder and at the file system root', () => {
  const fs = fakeFs(['/package.json', '/ws/package.json']);
  const lookup = createManifestLookup(fs.exists);
  const [dir, top] = resolveAll('/ws/a', '/ws');
  assert.deepEqual(lookup.above(dir, top), resolveAll('/ws/package.json'));
  assert.deepEqual(lookup.above(dir, undefined), resolveAll('/ws/package.json', '/package.json'));
});
