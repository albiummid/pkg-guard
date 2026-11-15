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

/** Parses yarn classic (v1) lockfiles. Returns null for yarn berry. */
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

export function buildYarnGraph(text: string, rootDeps: Record<string, string>): Graph | null {
  const index = parseYarnLock(text);
  if (!index) return null;
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
      const t = index.get(`${d}@${r}`);
      if (t && !node.deps.includes(idOf(t))) node.deps.push(idOf(t));
    }
  }
  const roots = new Map<string, string>();
  for (const [d, r] of Object.entries(rootDeps)) {
    const t = index.get(`${d}@${r}`);
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
