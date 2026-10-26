import { countBraces, detectIndent } from './packageJson';

function rewrite(text: string, obj: unknown): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let out = JSON.stringify(obj, null, detectIndent(text));
  if (eol === '\r\n') out = out.replace(/\n/g, '\r\n');
  if (/\r?\n$/.test(text)) out += eol;
  return out;
}

/** Adds name to a dependency section keeping keys alphabetical (the order npm / yarn write). */
export function addSorted(text: string, section: string, name: string, range: string): string {
  const obj = JSON.parse(text);
  const merged: Record<string, string> = { ...(obj[section] ?? {}), [name]: range };
  obj[section] = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b, 'en')));
  return rewrite(text, obj);
}

/** Removes name from every dependency section (an emptied section is dropped). */
export function removeDependency(text: string, name: string): string {
  const obj = JSON.parse(text);
  for (const s of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    if (obj[s] && name in obj[s]) {
      delete obj[s][name];
      if (!Object.keys(obj[s]).length) delete obj[s];
    }
  }
  return rewrite(text, obj);
}

export interface KeyLoc {
  key: string;
  line: number;
}

/** Lines of the top-level keys of an object section such as "scripts" (values may contain escaped quotes). */
export function locateKeys(text: string, section: string): KeyLoc[] {
  const out: KeyLoc[] = [];
  const open = new RegExp('^\\s*"' + section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*:\\s*\\{');
  let inside = false;
  let depth = 0;
  text.split(/\r?\n/).forEach((line, i) => {
    if (!inside) {
      if (open.test(line)) {
        depth = countBraces(line.slice(line.indexOf('{')));
        inside = depth > 0;
      }
      return;
    }
    if (depth === 1) {
      const m = /^\s*"((?:[^"\\]|\\.)*)"\s*:/.exec(line);
      if (m) out.push({ key: m[1], line: i });
    }
    depth += countBraces(line);
    if (depth <= 0) inside = false;
  });
  return out;
}
