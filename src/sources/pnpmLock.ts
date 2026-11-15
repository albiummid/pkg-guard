import { GNode, Graph } from '../types/index';

type Yaml = { [key: string]: Yaml | string };

const isMap = (v: Yaml | string | undefined): v is Yaml => typeof v === 'object' && v !== null;

function unquote(s: string): string {
  const t = s.trim();
  return t.length >= 2 && (t[0] === "'" || t[0] === '"') && t[t.length - 1] === t[0] ? t.slice(1, -1) : t;
}

/**
 * Reads the block-mapping subset of YAML that pnpm writes. Flow values (`{ integrity: x }`, `[a, b]`) stay as raw strings and list
 * items are skipped; the lockfile's dependency data is all plain nested maps.
 */
export function parseYamlMap(text: string): Yaml {
  const root: Yaml = {};
  const stack: { indent: number; map: Yaml }[] = [{ indent: -1, map: root }];
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || t.startsWith('#') || t.startsWith('- ') || t === '-' || t === '---') continue;
    const indent = raw.length - raw.trimStart().length;
    let key: string;
    let rest: string;
    if (t[0] === "'" || t[0] === '"') {
      const end = t.indexOf(t[0], 1);
      if (end < 0) continue;
      key = t.slice(1, end);
      rest = t.slice(end + 1);
      if (!rest.startsWith(':')) continue;
      rest = rest.slice(1);
    } else {
      const m = /:(\s|$)/.exec(t);
      if (!m) continue;
      key = t.slice(0, m.index);
      rest = t.slice(m.index + 1);
    }
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].map;
    const value = rest.trim();
    if (value === '' || value.startsWith('#')) {
      const child: Yaml = {};
      parent[key] = child;
      stack.push({ indent, map: child });
    } else {
      parent[key] = unquote(value.startsWith("'") || value.startsWith('"') ? value : value.replace(/\s+#.*$/, ''));
    }
  }
  return root;
}

/** `/name/1.0.0_peer` (lockfile v5) -> `name@1.0.0_peer`; later formats already read `name@1.0.0(peer)`, with an optional leading slash. */
function normKey(key: string, v5: boolean): string {
  const k = key.startsWith('/') ? key.slice(1) : key;
  if (!v5) return k;
  const i = k.indexOf('/', k.startsWith('@') ? k.indexOf('/') + 1 : 0);
  return i < 0 ? k : `${k.slice(0, i)}@${k.slice(i + 1)}`;
}

function nameVersion(norm: string): { name: string; version: string } | null {
  const at = norm.indexOf('@', 1);
  if (at < 0) return null;
  const version = norm.slice(at + 1).split(/[(_]/)[0];
  return /^\d/.test(version) ? { name: norm.slice(0, at), version } : null;
}

/**
 * pnpm-lock.yaml of any current format: v5 (pnpm 5-7, packages keyed `/name/1.0.0`), v6 (pnpm 8, `/name@1.0.0`) and v9 (pnpm 9-10,
 * dependencies under `snapshots`). `importer` is the folder of the manifest being scanned relative to the lockfile ('.' for the root):
 * each workspace member starts from its own importer entry. Returns null when the file has no `lockfileVersion`.
 */
export function buildPnpmGraph(text: string, rootDeps: Record<string, string>, importer = '.'): Graph | null {
  const lock = parseYamlMap(text);
  const lv = lock.lockfileVersion;
  if (typeof lv !== 'string') return null;
  const v5 = parseFloat(lv) < 6;
  const table = isMap(lock.snapshots) ? lock.snapshots : isMap(lock.packages) ? lock.packages : {};

  // one node per name@version: copies that differ only by their peer suffix are the same package
  const nodes = new Map<string, GNode>();
  const idOfKey = new Map<string, string>();
  for (const key of Object.keys(table)) {
    const norm = normKey(key, v5);
    const nv = nameVersion(norm);
    if (!nv) continue;
    const id = `${nv.name}@${nv.version}`;
    idOfKey.set(norm, id);
    if (!nodes.has(id)) nodes.set(id, { id, name: nv.name, version: nv.version, deps: [] });
  }
  /** Node id of dependency `name` pinned to `ref`; `ref` is a bare version or, for an alias, the real package's key. */
  const resolve = (name: string, ref: string | Yaml | undefined): string | undefined => {
    if (typeof ref !== 'string' || /^(link|file|workspace):/.test(ref)) return undefined;
    return idOfKey.get(/^\d/.test(ref) ? `${name}@${ref}` : normKey(ref, v5));
  };
  for (const [key, entry] of Object.entries(table)) {
    const id = idOfKey.get(normKey(key, v5));
    if (!id || !isMap(entry)) continue;
    const node = nodes.get(id)!;
    for (const section of ['dependencies', 'optionalDependencies']) {
      const deps = entry[section];
      if (!isMap(deps)) continue;
      for (const [d, ref] of Object.entries(deps)) {
        const t = resolve(d, ref);
        if (t && !node.deps.includes(t)) node.deps.push(t);
      }
    }
  }

  // v5 without workspaces keeps the project's own entry at the top level
  const importers = isMap(lock.importers) ? lock.importers : undefined;
  const entry = importers ? importers[importer] : importer === '.' ? lock : undefined;
  const roots = new Map<string, string>();
  if (isMap(entry)) {
    for (const d of Object.keys(rootDeps)) {
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        const deps = entry[section];
        const ref = isMap(deps) ? deps[d] : undefined;
        // v5 writes the version as the value; v6 and later write { specifier, version }
        const t = resolve(d, isMap(ref) ? ref.version : ref);
        if (t) {
          roots.set(d, t);
          break;
        }
      }
    }
  }
  return { kind: 'pnpm', nodes, roots };
}
