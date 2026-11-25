import { GNode, Graph } from '../types/index';

interface YarnPkg {
  name: string;
  version: string;
  deps: Record<string, string>;
}

/** Package name of a yarn.lock key. An alias (`cjs@npm:string-width@^4`) is named after the package it installs, not the alias. */
function nameOfSpec(spec: string): string {
  const alias = /@npm:(@?[^@]+)@[^@]*$/.exec(spec);
  return alias ? alias[1] : spec.slice(0, spec.lastIndexOf('@'));
}

/** Parses yarn classic (v1) lockfiles. Returns null for yarn berry (see parseBerryLock). */
export function parseYarnLock(text: string): Map<string, YarnPkg> | null {
  if (/^__metadata:/m.test(text)) return null;
  const index = new Map<string, YarnPkg>();
  let cur: { specs: string[]; pkg: YarnPkg } | null = null;
  let inDeps = false;
  const flush = () => {
    if (cur) for (const s of cur.specs) index.set(s, cur.pkg);
    cur = null;
    inDeps = false;
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith('#')) continue;
    if (!line.startsWith(' ')) {
      flush();
      const specs = line
        .replace(/:\s*$/, '')
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, ''));
      cur = { specs, pkg: { name: nameOfSpec(specs[0]), version: '', deps: {} } };
      continue;
    }
    if (!cur) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 2) {
      const v = /^\s+version "([^"]+)"/.exec(line);
      if (v) cur.pkg.version = v[1];
      inDeps = /^\s+(dependencies|optionalDependencies):/.test(line);
    } else if (indent === 4 && inDeps) {
      const m = /^\s+("?)(\S+?)\1\s+"?([^"]*)"?\s*$/.exec(line);
      if (m) cur.pkg.deps[m[2]] = m[3];
    }
  }
  flush();
  return index;
}

/** A yarn berry lockfile: its package entries by descriptor, and the workspace entries by folder ('.' is the root). */
interface BerryLock {
  index: Map<string, YarnPkg>;
  workspaces: Map<string, Record<string, string>>;
}

/** Parses a yarn berry (v2+) yarn.lock. Workspace members and other non-registry entries are not packages, so they get no node. */
function parseBerryLock(text: string): BerryLock {
  const index = new Map<string, YarnPkg>();
  const workspaces = new Map<string, Record<string, string>>();
  const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, '$1');
  let cur: { specs: string[]; pkg: YarnPkg; resolution: string } | null = null;
  let inDeps = false;
  const flush = () => {
    if (cur) {
      const ws = /@workspace:(.*)$/.exec(cur.resolution);
      if (ws) workspaces.set(ws[1], cur.pkg.deps);
      else if (cur.pkg.version && /^@?[^@]+@npm:/.test(cur.resolution)) for (const s of cur.specs) index.set(s, cur.pkg);
    }
    cur = null;
    inDeps = false;
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (!line.startsWith(' ')) {
      flush();
      const key = unquote(line.replace(/:\s*$/, ''));
      if (key === '__metadata') continue;
      cur = { specs: key.split(/,\s+(?=@?[^@\s,]+@)/).map((x) => x.trim()), pkg: { name: '', version: '', deps: {} }, resolution: '' };
      continue;
    }
    if (!cur) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 2) {
      const m = /^\s+(\w+):\s*(.*)$/.exec(line);
      inDeps = !!m && m[1] === 'dependencies' && !m[2];
      if (m?.[1] === 'version') cur.pkg.version = unquote(m[2]);
      else if (m?.[1] === 'resolution') {
        cur.resolution = unquote(m[2]);
        cur.pkg.name = /^(@?[^@]+)@/.exec(cur.resolution)?.[1] ?? '';
      }
    } else if (indent === 4 && inDeps) {
      const m = /^\s+("[^"]+"|[^\s:]+):\s*(.*)$/.exec(line);
      if (m) cur.pkg.deps[unquote(m[1])] = unquote(m[2]);
    }
  }
  flush();
  return { index, workspaces };
}

/** The lockfile key of a dependency range: a plain range is an npm range; an alias (`npm:real@^1`) or other protocol keeps its own prefix. */
const berryKey = (name: string, range: string) => `${name}@${/^[a-z]+:/.test(range) ? range : 'npm:' + range}`;

/**
 * Graph of a yarn.lock, classic (v1) or berry (v2+).
 * `from` is the folder of the manifest being scanned relative to the lockfile ('' or '.' for the root, 'packages/api' for a workspace member):
 * in a berry lockfile its dependencies resolve from the member's own workspace entry.
 */
export function buildYarnGraph(text: string, rootDeps: Record<string, string>, from = ''): Graph | null {
  let index: Map<string, YarnPkg>;
  let find: (d: string, r: string) => YarnPkg | undefined;
  let ranges = rootDeps;
  if (/^__metadata:/m.test(text)) {
    const lock = parseBerryLock(text);
    index = lock.index;
    find = (d, r) => index.get(berryKey(d, r));
    // the member's own entry holds the ranges yarn resolved (after `resolutions`); fall back to the manifest's
    const own = lock.workspaces.get(from || '.');
    if (own) ranges = Object.fromEntries(Object.keys(rootDeps).map((d) => [d, own[d] ?? rootDeps[d]]));
  } else {
    const classic = parseYarnLock(text);
    if (!classic) return null;
    index = classic;
    find = (d, r) => index.get(`${d}@${r}`);
  }
  const nodes = new Map<string, GNode>();
  const idOf = (p: YarnPkg) => `${p.name}@${p.version}`;
  const pkgs = new Set(index.values());
  for (const p of pkgs) {
    const id = idOf(p);
    if (!nodes.has(id)) nodes.set(id, { id, name: p.name, version: p.version, deps: [] });
  }
  for (const p of pkgs) {
    const node = nodes.get(idOf(p))!;
    for (const [d, r] of Object.entries(p.deps)) {
      const t = find(d, r);
      if (t && !node.deps.includes(idOf(t))) node.deps.push(idOf(t));
    }
  }
  const roots = new Map<string, string>();
  for (const [d, r] of Object.entries(ranges)) {
    const t = find(d, r);
    if (t) roots.set(d, idOf(t));
  }
  return { kind: 'yarn', nodes, roots };
}

/**
 * package-lock.json lockfileVersion 2/3. Returns null for v1 or unreadable.
 * `from` is the lockfile key of the manifest being scanned ('' for the root, 'packages/api' for a workspace member): its dependencies
 * resolve to the member's own node_modules first, then the root's, the way Node resolves them.
 */
export function buildNpmGraph(json: any, rootDeps: Record<string, string>, from = ''): Graph | null {
  const pk = json?.packages;
  if (!pk || typeof pk !== 'object') return null;
  const nodes = new Map<string, GNode>();
  for (const [key, p] of Object.entries<any>(pk)) {
    // Workspace members sit under their folder (e.g. "packages/api"), not node_modules, and are not registry packages.
    if (!key || p.link || !p.version || !key.includes('node_modules/')) continue;
    // an alias entry records the real package name; otherwise the name is the folder
    const name: string = typeof p.name === 'string' && p.name ? p.name : key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    nodes.set(key, { id: key, name, version: p.version, deps: [] });
  }
  const resolve = (dep: string, from: string): string | undefined => {
    let p = from;
    for (;;) {
      const cand = `${p ? p + '/' : ''}node_modules/${dep}`;
      if (nodes.has(cand)) return cand;
      if (!p) return undefined;
      const cut = p.lastIndexOf('/node_modules/');
      p = cut >= 0 ? p.slice(0, cut) : '';
    }
  };
  for (const [key, node] of nodes) {
    const p = pk[key];
    // npm 7+ installs peer dependencies, so they are part of the tree
    for (const d of Object.keys({ ...p.dependencies, ...p.optionalDependencies, ...p.peerDependencies })) {
      const t = resolve(d, key);
      if (t && !node.deps.includes(t)) node.deps.push(t);
    }
  }
  const roots = new Map<string, string>();
  for (const d of Object.keys(rootDeps)) {
    const t = resolve(d, from);
    if (t) roots.set(d, t);
  }
  return { kind: 'npm', nodes, roots };
}

/** bun.lock is JSONC: it allows trailing commas and comments, which JSON.parse does not. */
function parseJsonc(text: string): any {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Splits a bun.lock package key (`a/b`, `@s/n/@s/m`) into the package names it nests. */
function keySegments(key: string): string[] {
  const parts = key.split('/');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) out.push(parts[i].startsWith('@') && i + 1 < parts.length ? `${parts[i]}/${parts[++i]}` : parts[i]);
  return out;
}

/**
 * Text lockfile of bun (bun.lock). Returns null when it cannot be read; the binary bun.lockb is never passed here.
 * A package key is its install path: `foo` is the hoisted copy, `bar/foo` the copy nested under bar.
 */
export function buildBunGraph(text: string, rootDeps: Record<string, string>): Graph | null {
  let pk: Record<string, any>;
  try {
    pk = parseJsonc(text)?.packages;
  } catch {
    return null;
  }
  if (!pk || typeof pk !== 'object') return null;
  const nodes = new Map<string, GNode>();
  for (const [key, entry] of Object.entries(pk)) {
    const ident = Array.isArray(entry) && typeof entry[0] === 'string' ? entry[0] : '';
    const at = ident.lastIndexOf('@');
    const version = ident.slice(at + 1);
    // workspace members, file:, git and tarball entries are not registry packages
    if (at <= 0 || !/^\d/.test(version)) continue;
    nodes.set(key, { id: key, name: ident.slice(0, at), version, deps: [] });
  }
  const resolve = (dep: string, from: string): string | undefined => {
    const segs = from ? keySegments(from) : [];
    for (let n = segs.length; n >= 0; n--) {
      const cand = [...segs.slice(0, n), dep].join('/');
      if (nodes.has(cand)) return cand;
    }
    return undefined;
  };
  for (const [key, node] of nodes) {
    const meta = pk[key][2] ?? {};
    for (const d of Object.keys({ ...meta.dependencies, ...meta.optionalDependencies, ...meta.peerDependencies })) {
      const t = resolve(d, key);
      if (t && !node.deps.includes(t)) node.deps.push(t);
    }
  }
  const roots = new Map<string, string>();
  for (const d of Object.keys(rootDeps)) {
    const t = resolve(d, '');
    if (t) roots.set(d, t);
  }
  return { kind: 'bun', nodes, roots };
}

/** A range one package (or the project, `by: ''`) requests for another, as recorded in a lockfile. */
export interface LockRequest {
  name: string;
  range: string;
  by: string;
}

/** Package name and range of a dependency range, following an npm alias (`npm:real@^1` installs `real`). */
function requestOf(name: string, range: string): { name: string; range: string } {
  const alias = /^npm:(@?[^@]+)@(.*)$/.exec(range);
  if (alias) return { name: alias[1], range: alias[2] };
  return { name, range: range.replace(/^npm:/, '') };
}

/** Package name and range of a lockfile key (`name@range`, `name@npm:range`, `alias@npm:real@range`). */
function specRequest(spec: string): { name: string; range: string } {
  const at = spec.indexOf('@', 1);
  return requestOf(spec.slice(0, at), spec.slice(at + 1));
}

/**
 * Every range requested in a yarn.lock (classic or berry): what each package's entry asks for, what the workspaces ask for, and
 * the keys no package asks for (the project's own requests, including a resolution's range) with `by: ''`.
 */
export function lockRequests(text: string): LockRequest[] | null {
  const out = new Map<string, LockRequest>();
  const add = (q: LockRequest) => out.set(`${q.name}@${q.range}@${q.by}`, q);
  let index: Map<string, YarnPkg>;
  if (/^__metadata:/m.test(text)) {
    const lock = parseBerryLock(text);
    index = lock.index;
    for (const deps of lock.workspaces.values()) for (const [d, r] of Object.entries(deps)) add({ ...requestOf(d, r), by: '' });
  } else {
    const classic = parseYarnLock(text);
    if (!classic) return null;
    index = classic;
  }
  for (const p of new Set(index.values())) for (const [d, r] of Object.entries(p.deps)) add({ ...requestOf(d, r), by: p.name });
  const asked = new Set([...out.values()].map((q) => `${q.name}@${q.range}`));
  for (const spec of index.keys()) {
    const q = specRequest(spec);
    if (!asked.has(`${q.name}@${q.range}`)) add({ ...q, by: '' });
  }
  return [...out.values()];
}

/** Every range requested in a package-lock.json v2/v3: by each installed package, and by the project (`by: ''`) and its workspace members. */
export function npmLockRequests(json: any): LockRequest[] {
  const out = new Map<string, LockRequest>();
  for (const [key, p] of Object.entries<any>(json?.packages ?? {})) {
    if (!p || typeof p !== 'object' || p.link) continue;
    const inModules = key.includes('node_modules/');
    const by = !inModules ? '' : typeof p.name === 'string' && p.name ? p.name : key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const deps: Record<string, string> = { ...p.peerDependencies, ...p.optionalDependencies, ...p.dependencies, ...(inModules ? {} : p.devDependencies) };
    for (const [d, r] of Object.entries(deps)) {
      if (typeof r !== 'string') continue;
      const q = { ...requestOf(d, r), by };
      out.set(`${q.name}@${q.range}@${by}`, q);
    }
  }
  return [...out.values()];
}
