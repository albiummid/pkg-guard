import { execFile } from 'child_process';
import { normSeverity } from './osv';
import { GNode, Graph, Hit, Vuln } from '../types/index';

/**
 * How to start `<pm> audit --json`. The command line is constant, so there is nothing to inject into. On Windows npm and yarn are
 * `.cmd` shims, which only run through cmd.exe; passing an argument list together with `shell: true` is deprecated in Node 24.
 */
export function auditInvocation(kind: 'yarn' | 'npm', platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === 'win32') return { file: 'cmd.exe', args: ['/d', '/s', '/c', `${kind} audit --json`] };
  return { file: kind, args: ['audit', '--json'] };
}

function run(kind: 'yarn' | 'npm', cwd: string): Promise<string> {
  const { file, args } = auditInvocation(kind);
  return new Promise((resolve, reject) => {
    // audit exits non-zero when it finds something, so stdout is used regardless of the exit code; the parser decides whether it is a report
    execFile(file, args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 120000 }, (err, stdout) => {
      if (stdout) resolve(stdout);
      else reject(err ?? new Error('empty audit output'));
    });
  });
}

function singleMin(patched: string | undefined): string | undefined {
  const m = /^>=\s*([\w.+-]+)$/.exec((patched ?? '').trim());
  return m ? m[1] : undefined;
}

/** Throws unless the output is a complete yarn report (it ends with an auditSummary line), so a failed audit never reads as "no vulnerabilities". */
export function parseYarnAudit(stdout: string): Hit[] {
  const hits: Hit[] = [];
  let complete = false;
  for (const line of stdout.split('\n')) {
    let l: any;
    try {
      l = JSON.parse(line);
    } catch {
      continue;
    }
    if (l.type === 'auditSummary') complete = true;
    if (l.type !== 'auditAdvisory') continue;
    const a = l.data.advisory;
    const path: string[] = String(l.data.resolution.path).split('>');
    const vuln: Vuln = {
      id: a.github_advisory_id ?? `npm:${a.id}`,
      url: a.url,
      summary: a.title,
      severity: normSeverity(a.severity),
      fixedIn: singleMin(a.patched_versions),
      pkg: a.module_name,
      version: a.findings?.[0]?.version ?? '',
    };
    hits.push({ root: path[0], path, vuln });
  }
  if (!complete) throw new Error('yarn audit did not return a complete report');
  return hits;
}

/** Throws unless the output is an npm 7+ report, so an error or an old-format report never reads as "no vulnerabilities". */
export function parseNpmAudit(stdout: string): Hit[] {
  let j: any;
  try {
    j = JSON.parse(stdout);
  } catch {
    throw new Error('npm audit did not return JSON');
  }
  if (j?.error) throw new Error(`npm audit failed: ${j.error.summary ?? j.error.code ?? 'unknown error'}`);
  if (j?.advisories && !j.vulnerabilities) throw new Error('npm audit output from npm 6 is not supported; npm 7 or newer is needed');
  if (!j?.vulnerabilities || typeof j.vulnerabilities !== 'object') throw new Error('npm audit did not return a vulnerabilities report');
  const vs: Record<string, any> = j.vulnerabilities;
  const hits: Hit[] = [];
  const rootsOf = (name: string, seen = new Set<string>()): string[] => {
    if (seen.has(name)) return [];
    seen.add(name);
    const v = vs[name];
    if (!v) return [];
    if (v.isDirect) return [name];
    return (v.effects ?? []).flatMap((e: string) => rootsOf(e, seen));
  };
  for (const [name, v] of Object.entries<any>(vs)) {
    for (const via of v.via ?? []) {
      if (typeof via === 'string') continue;
      const id = String(via.url ?? '').split('/').pop() || `npm:${via.source}`;
      const vuln: Vuln = {
        id,
        url: via.url ?? '',
        summary: via.title ?? id,
        severity: normSeverity(via.severity),
        fixedIn: undefined,
        pkg: name,
        version: '',
      };
      for (const root of rootsOf(name)) hits.push({ root, path: root === name ? [root] : [root, name], vuln });
    }
  }
  return hits;
}

export async function runAudit(kind: Graph['kind'], cwd: string): Promise<Hit[]> {
  if (kind === 'yarn') return parseYarnAudit(await run('yarn', cwd));
  if (kind === 'npm') return parseNpmAudit(await run('npm', cwd));
  throw new Error('no lockfile');
}

/** Walks the graph from every direct dependency and attributes vulnerable nodes to the dependency that pulls them in. */
export function attribute(g: Graph, vulns: Map<string, Vuln[]>): Hit[] {
  const hits: Hit[] = [];
  const rootIds = new Set(g.roots.values());
  for (const [root, rid] of g.roots) {
    const parent = new Map<string, string | null>([[rid, null]]);
    const queue = [rid];
    while (queue.length) {
      const id = queue.shift()!;
      const node: GNode | undefined = g.nodes.get(id);
      if (!node) continue;
      if (id !== rid && rootIds.has(id)) continue; // reported on its own line
      const vs = vulns.get(`${node.name}@${node.version}`);
      if (vs) {
        const path: string[] = [];
        for (let c: string | null = id; c; c = parent.get(c) ?? null) path.unshift(g.nodes.get(c)!.name);
        for (const vuln of vs) hits.push({ root, path, vuln });
      }
      for (const d of node.deps) {
        if (!parent.has(d)) {
          parent.set(d, id);
          queue.push(d);
        }
      }
    }
  }
  return hits;
}
