import { GNode, Graph } from '../types';

interface YarnPkg {
  name: string;
  version: string;
  deps: Record<string, string>;
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
      const at = specs[0].lastIndexOf('@');
      cur = { specs, pkg: { name: specs[0].slice(0, at), version: '', deps: {} } };
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

/** package-lock.json lockfileVersion 2/3. Returns null for v1 or unreadable. */
export function buildNpmGraph(json: any, rootDeps: Record<string, string>): Graph | null {
  const pk = json?.packages;
  if (!pk || typeof pk !== 'object') return null;
  const nodes = new Map<string, GNode>();
  for (const [key, p] of Object.entries<any>(pk)) {
    if (!key || p.link || !p.version) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
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
    for (const d of Object.keys({ ...p.dependencies, ...p.optionalDependencies })) {
      const t = resolve(d, key);
      if (t) node.deps.push(t);
    }
  }
  const roots = new Map<string, string>();
  for (const d of Object.keys(rootDeps)) {
    const t = resolve(d, '');
    if (t) roots.set(d, t);
  }
  return { kind: 'npm', nodes, roots };
}
