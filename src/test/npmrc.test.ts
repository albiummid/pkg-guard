import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { clearRegistryCache, fetchInfo } from '../sources/registry';
import { fetchMeta } from '../sources/changelog';
import { resolveRegistry } from '../sources/npmrc';
import { osvQuery } from '../sources/osv';

const PUBLIC = 'https://registry.npmjs.org';
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

/** A user .npmrc and a project folder with its own .npmrc, torn down after `body`. */
async function withNpmrc<T>(user: string, project: string, body: (dir: string) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgguard-npmrc-'));
  const userFile = path.join(root, 'user.npmrc');
  const dir = path.join(root, 'proj');
  fs.mkdirSync(dir);
  fs.writeFileSync(userFile, user);
  fs.writeFileSync(path.join(dir, '.npmrc'), project);
  const old = process.env.NPM_CONFIG_USERCONFIG;
  process.env.NPM_CONFIG_USERCONFIG = userFile;
  clearRegistryCache();
  try {
    return await body(dir);
  } finally {
    if (old === undefined) delete process.env.NPM_CONFIG_USERCONFIG;
    else process.env.NPM_CONFIG_USERCONFIG = old;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function withFetch<T>(impl: (url: string, init?: any) => Response, body: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => impl(String(url), init)) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = real;
  }
}

const doc = { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } };

test('npmrc: a scoped package goes to the registry its scope maps to, with that registry\'s token only', async () => {
  await withNpmrc('@corp:registry=https://npm.corp.example/repo/\n//npm.corp.example/repo/:_authToken=sekret\n', '', async (dir) => {
    const seen: { url: string; auth?: string }[] = [];
    await withFetch((url, init) => { seen.push({ url, auth: init?.headers?.authorization }); return json(doc); }, async () => {
      assert.equal((await fetchInfo('@corp/lib', PUBLIC, { dir, trusted: true }))!.latest, '1.0.0');
      await fetchInfo('left-pad', PUBLIC, { dir, trusted: true });
      await fetchMeta('@corp/lib', PUBLIC, { dir, trusted: true });
    });
    assert.deepEqual(seen[0], { url: 'https://npm.corp.example/repo/@corp%2flib', auth: 'Bearer sekret' });
    assert.deepEqual(seen[1], { url: `${PUBLIC}/left-pad`, auth: undefined });
    assert.equal(seen[2].auth, 'Bearer sekret');
  });
});

test('npmrc: credentials never reach OSV.dev or a registry they do not belong to', async () => {
  await withNpmrc('//other.example/:_authToken=other\n@corp:registry=https://npm.corp.example/\n//npm.corp.example/:_auth=dTpw\n', '', async (dir) => {
    const seen: { url: string; auth?: string }[] = [];
    await withFetch((url, init) => { seen.push({ url, auth: init?.headers?.authorization }); return json({ results: [] }); }, async () => {
      await osvQuery([{ name: 'a', version: '1.0.0' }]);
      await fetchInfo('plain', PUBLIC, { dir, trusted: true });
      await fetchInfo('@corp/x', PUBLIC, { dir, trusted: true });
    });
    assert.ok(seen[0].url.includes('osv.dev'));
    assert.deepEqual(seen.map((s) => s.auth), [undefined, undefined, 'Basic dTpw']);
  });
});

test('npmrc: username and password pair become basic auth', async () => {
  await withNpmrc(`//r.example/:username=u\n//r.example/:_password=${Buffer.from('p').toString('base64')}\n`, '', async () => {
    assert.equal(resolveRegistry('x', 'https://r.example/').authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
  });
});

test('npmrc: an untrusted workspace ignores the project .npmrc, a trusted one honours it', async () => {
  await withNpmrc('', '@corp:registry=https://evil.example/\n//evil.example/:_authToken=t\n', async (dir) => {
    assert.equal(resolveRegistry('@corp/x', PUBLIC, { dir, trusted: false }).registry, PUBLIC);
    assert.equal(resolveRegistry('@corp/x', PUBLIC, { dir }).registry, PUBLIC);
    const t = resolveRegistry('@corp/x', PUBLIC, { dir, trusted: true });
    assert.deepEqual([t.registry, t.authorization], ['https://evil.example/', 'Bearer t']);
  });
});

test('npmrc: a private scope is never looked up on the public registry', async () => {
  await withNpmrc('@corp:registry=not a url\n', '', async (dir) => {
    let calls = 0;
    await withFetch(() => { calls++; return json(doc); }, async () => {
      assert.equal(await fetchInfo('@corp/lib', PUBLIC, { dir, trusted: true }), null);
      assert.equal(await fetchMeta('@corp/lib', PUBLIC, { dir, trusted: true }), null);
    });
    assert.equal(calls, 0);
  });
  // a rejected request (no usable credentials) stays a failure rather than retrying elsewhere
  await withNpmrc('@corp:registry=https://npm.corp.example/\n', '', async (dir) => {
    const urls: string[] = [];
    await withFetch((url) => { urls.push(url); return json({}, 401); }, async () => {
      assert.equal(await fetchInfo('@corp/lib', PUBLIC, { dir, trusted: true }), null);
    });
    assert.deepEqual(urls, ['https://npm.corp.example/@corp%2flib']);
  });
});

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal npmrc syntax
test('npmrc: ${VAR} in values is expanded and an unset variable drops the entry', async () => {
  process.env.PKG_GUARD_TEST_TOKEN = 'fromenv';
  try {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal npmrc syntax
    await withNpmrc('//r.example/:_authToken=${PKG_GUARD_TEST_TOKEN}\n//s.example/:_authToken=${PKG_GUARD_UNSET_VAR}\n', '', async () => {
      assert.equal(resolveRegistry('x', 'https://r.example/').authorization, 'Bearer fromenv');
      assert.equal(resolveRegistry('x', 'https://s.example/').authorization, undefined);
    });
  } finally {
    delete process.env.PKG_GUARD_TEST_TOKEN;
  }
});

test('npmrc: credentials match a registry by path prefix and the default registry= applies only to the public default', async () => {
  await withNpmrc('registry=https://mirror.example/npm/\n//mirror.example/:_authToken=m\n', '', async () => {
    assert.equal(resolveRegistry('x', PUBLIC).registry, 'https://mirror.example/npm/');
    assert.equal(resolveRegistry('x', PUBLIC).authorization, 'Bearer m');
    assert.equal(resolveRegistry('x', 'https://custom.example/').registry, 'https://custom.example/');
    assert.equal(resolveRegistry('x', 'https://custom.example/').authorization, undefined);
  });
});

test('npmrc: a redirect to another origin does not carry the registry credentials', async () => {
  const seen: { host: string; auth?: string }[] = [];
  const serve = (handler: (res: http.ServerResponse) => void) => new Promise<http.Server>((resolve) => {
    const s = http.createServer((req, res) => { seen.push({ host: String(req.headers.host), auth: req.headers.authorization }); handler(res); });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const target = await serve((res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(doc)); });
  const targetPort = (target.address() as import('net').AddressInfo).port;
  const origin = await serve((res) => { res.statusCode = 302; res.setHeader('location', `http://127.0.0.1:${targetPort}/redirected`); res.end(); });
  const originPort = (origin.address() as import('net').AddressInfo).port;
  const registry = `http://127.0.0.1:${originPort}/`;
  try {
    await withNpmrc(`//127.0.0.1:${originPort}/:_authToken=sekret
`, '', async (dir) => {
      assert.equal((await fetchInfo('x', registry, { dir, trusted: true }))?.latest, '1.0.0');
    });
  } finally {
    origin.close();
    target.close();
  }
  assert.equal(seen.length, 2);
  assert.equal(seen[0].auth, 'Bearer sekret');
  assert.equal(seen[1].auth, undefined);
});
