// Per-scope registries and credentials from the user's and the project's .npmrc files.
// Only what registry lookups need is read: `registry`, `@scope:registry` and the `//host/path/:` credential keys.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Where a lookup happens: the folder of the manifest (to find the project .npmrc) and whether the workspace is trusted. */
export interface NpmrcScope {
  dir?: string;
  /** Project .npmrc files are only read when this is true; the user's file is always read. */
  trusted?: boolean;
}

interface Credentials {
  token?: string;
  /** base64 of `user:password` */
  basic?: string;
  user?: string;
  /** decoded password */
  password?: string;
}

export interface NpmrcConfig {
  registry?: string;
  scopes: Map<string, string>;
  /** credentials keyed by the `//host/path/` prefix they belong to */
  auth: Map<string, Credentials>;
}

export interface Resolved {
  /** registry base URL, or null when the package must not be looked up at all */
  registry: string | null;
  authorization?: string;
}

const PUBLIC = 'https://registry.npmjs.org';
const files = new Map<string, { mtime: number; entries: Map<string, string> }>();

function expand(v: string): string | null {
  let missing = false;
  const out = v.replace(/\$\{([^}]+)\}/g, (_m, n) => {
    const e = process.env[n];
    if (e === undefined) missing = true;
    return e ?? '';
  });
  return missing ? null : out;
}

function readFile(file: string): Map<string, string> {
  try {
    const mtime = fs.statSync(file).mtimeMs;
    const hit = files.get(file);
    if (hit && hit.mtime === mtime) return hit.entries;
    const entries = new Map<string, string>();
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
      const x = expand(v);
      if (x !== null) entries.set(k, x);
    }
    files.set(file, { mtime, entries });
    return entries;
  } catch {
    return new Map();
  }
}

function userFile(): string {
  return process.env.NPM_CONFIG_USERCONFIG || path.join(os.homedir(), '.npmrc');
}

/** `//host/path/` form npm uses to key credentials. */
export function nerf(url: string): string | null {
  try {
    const u = new URL(url);
    return `//${u.host}${u.pathname.endsWith('/') ? u.pathname : u.pathname + '/'}`;
  } catch {
    return null;
  }
}

/** Reads the user's .npmrc, then (trusted workspaces only) the project's, nearest folder last so it wins. */
export function loadNpmrc(scope: NpmrcScope = {}): NpmrcConfig {
  const sources = [userFile()];
  if (scope.trusted && scope.dir) {
    const dirs: string[] = [];
    for (let d = path.resolve(scope.dir); ; d = path.dirname(d)) {
      dirs.unshift(d);
      if (path.dirname(d) === d) break;
    }
    for (const d of dirs) {
      const f = path.join(d, '.npmrc');
      if (path.resolve(f) !== path.resolve(userFile())) sources.push(f);
    }
  }
  const cfg: NpmrcConfig = { scopes: new Map(), auth: new Map() };
  for (const f of sources) {
    for (const [k, v] of readFile(f)) {
      let m: RegExpExecArray | null;
      if (k === 'registry') cfg.registry = v;
      else if ((m = /^(@[^:]+):registry$/.exec(k))) cfg.scopes.set(m[1], v);
      else if ((m = /^(\/\/.+\/):(_authToken|_auth|username|_password)$/.exec(k))) {
        const a = cfg.auth.get(m[1]) ?? {};
        if (m[2] === '_authToken') a.token = v;
        else if (m[2] === '_auth') a.basic = v;
        else if (m[2] === 'username') a.user = v;
        else a.password = Buffer.from(v, 'base64').toString('utf8');
        cfg.auth.set(m[1], a);
      }
    }
  }
  for (const a of cfg.auth.values()) if (!a.basic && a.user !== undefined && a.password !== undefined) a.basic = Buffer.from(`${a.user}:${a.password}`).toString('base64');
  return cfg;
}

function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();
}

function authorizationFor(registry: string, cfg: NpmrcConfig): string | undefined {
  let key = nerf(registry);
  // exact prefix first, then shorter paths up to the host root, as npm does; never another host
  while (key) {
    const a = cfg.auth.get(key);
    if (a?.token) return `Bearer ${a.token}`;
    if (a?.basic) return `Basic ${a.basic}`;
    const up = key.replace(/[^/]+\/$/, '');
    key = up === key || up === '//' ? null : up;
  }
  return undefined;
}

/**
 * The registry a package is looked up on, and the credentials that belong to exactly that registry.
 * A scope mapped in .npmrc never falls back to `fallback`: an unusable mapping means no lookup (registry null).
 */
export function resolveRegistry(name: string, fallback: string, scope: NpmrcScope = {}): Resolved {
  const cfg = loadNpmrc(scope);
  const pkgScope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : null;
  let registry: string | undefined = pkgScope ? cfg.scopes.get(pkgScope) : undefined;
  if (registry === undefined) registry = cfg.registry && sameUrl(fallback, PUBLIC) ? cfg.registry : fallback;
  if (!nerf(registry) || !/^https?:\/\//i.test(registry)) return { registry: null };
  return { registry, authorization: authorizationFor(registry, cfg) };
}
