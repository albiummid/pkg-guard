import { Finding, ImportFinding, ManifestFindings } from '../types';
import { locateImports } from './locate';

const RANK: Record<Finding['level'], number> = { error: 3, warning: 2, info: 1 };

/**
 * Vulnerability Findings of the packages a source file imports. `manifests` are the package.jsons above the file, nearest
 * first: a package is looked up in the nearest one that declares it, as node resolution would usually pick that copy.
 */
export function importFindings(text: string, manifests: ManifestFindings[]): ImportFinding[] {
  const owner = new Map<string, Finding[]>();
  for (const m of manifests) {
    for (const e of m.entries) if (!owner.has(e.name)) owner.set(e.name, m.findings.filter((f) => f.entry.name === e.name && (f.kind === 'vuln' || f.kind === 'transitive')));
  }
  const out: ImportFinding[] = [];
  for (const ref of locateImports(text)) {
    const fs = [...(owner.get(ref.name) ?? [])].sort((a, b) => RANK[b.level] - RANK[a.level]);
    if (!fs.length) continue;
    // one count for the transitive ones: listing each package, as package.json does, is too long at the end of an import
    const transitive = fs.filter((f) => f.kind === 'transitive').length;
    const inline = fs.filter((f) => f.kind === 'vuln').map((f) => f.inline);
    if (transitive) inline.push(`⚠ ${transitive} vulnerable transitive dep${transitive === 1 ? '' : 's'}`);
    out.push({
      ref,
      level: fs[0].level,
      message: fs.map((f) => f.message).join('\n\n'),
      inline: inline.join('  '),
      code: fs[0].code,
      url: fs[0].url,
    });
  }
  return out;
}
