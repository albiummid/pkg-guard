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
