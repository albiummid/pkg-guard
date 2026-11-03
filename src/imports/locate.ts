import { ImportRef } from '../types';

// `from 'x'` also covers `export … from` and the last line of a multi-line import
const PATTERNS = [/\bfrom\s*(['"])([^'"\n]+)\1/g, /^\s*import\s*(['"])([^'"\n]+)\1/g, /\b(?:require|import)\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g];

/** Package name of a bare specifier; undefined for relative paths, URLs / protocols (`node:`) and path aliases (`@/`, `~/`, `#`). */
export function packageName(spec: string): string | undefined {
  if (/^[./~#]|^@\/|^[a-z][\w+.-]*:/i.test(spec)) return undefined;
  const parts = spec.split('/');
  if (spec.startsWith('@')) return parts.length > 1 && parts[1] ? `${parts[0]}/${parts[1]}` : undefined;
  return parts[0];
}

/** Blanks out comments, keeping columns, so commented-out imports are not reported. Strings are skipped so `'http://x'` stays. */
function stripComments(line: string, inBlock: boolean): { code: string; inBlock: boolean } {
  let code = '';
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inBlock) {
      if (c === '*' && line[i + 1] === '/') {
        inBlock = false;
        code += '  ';
        i++;
      } else code += ' ';
    } else if (quote) {
      code += c;
      if (c === '\\') code += line[++i] ?? '';
      else if (c === quote) quote = '';
    } else if (c === '/' && line[i + 1] === '/') {
      break;
    } else if (c === '/' && line[i + 1] === '*') {
      inBlock = true;
      code += '  ';
      i++;
    } else {
      if (c === "'" || c === '"' || c === '`') quote = c;
      code += c;
    }
  }
  return { code, inBlock };
}

/** Locates the package imports (line/column) of a JS/TS source file without a parser. */
export function locateImports(text: string): ImportRef[] {
  const out: ImportRef[] = [];
  let inBlock = false;
  text.split(/\r?\n/).forEach((raw, line) => {
    const stripped = stripComments(raw, inBlock);
    inBlock = stripped.inBlock;
    const seen = new Set<number>();
    for (const re of PATTERNS) {
      for (const m of stripped.code.matchAll(re)) {
        const start = m.index! + m[0].indexOf(m[1]);
        const name = packageName(m[2]);
        if (!name || seen.has(start)) continue;
        seen.add(start);
        out.push({ name, line, start, end: start + m[2].length + 2 });
      }
    }
  });
  return out.sort((a, b) => a.line - b.line || a.start - b.start);
}
