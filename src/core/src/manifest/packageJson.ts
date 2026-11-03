export type Section = 'dependencies' | 'devDependencies' | 'optionalDependencies';

export interface DepEntry {
  name: string;
  range: string;
  section: Section;
  line: number;
  /** column of the opening quote of the name */
  nameStart: number;
  /** column just after the closing quote of the version */
  end: number;
  /** column of the first char inside the version quotes, and just past the last */
  versionStart: number;
  versionEnd: number;
}

const SECTION_RE = /^\s*"(dependencies|devDependencies|optionalDependencies)"\s*:\s*\{/;
const ENTRY_RE = /^(\s*)"([^"]+)"\s*:\s*"([^"]*)"/;
const STRING_RE = /"(?:[^"\\]|\\.)*"/g;

export function countBraces(line: string): number {
  const bare = line.replace(STRING_RE, '""');
  let d = 0;
  for (const c of bare) {
    if (c === '{') d++;
    else if (c === '}') d--;
  }
  return d;
}

/** Locates the dependency entries (line/column) of a package.json without a JSON parser, so positions stay exact. */
export function locateDeps(text: string): DepEntry[] {
  const out: DepEntry[] = [];
  const lines = text.split(/\r?\n/);
  let section: Section | null = null;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!section) {
      const m = SECTION_RE.exec(line);
      if (m) {
        section = m[1] as Section;
        depth = countBraces(line.slice(line.indexOf('{')));
        if (depth <= 0) section = null;
      }
      continue;
    }
    if (depth === 1) {
      const m = ENTRY_RE.exec(line);
      if (m) {
        const nameStart = m[1].length;
        const afterName = line.indexOf('"', nameStart + 1) + 1;
        const vOpen = line.indexOf('"', line.indexOf(':', afterName) + 1);
        const vClose = line.indexOf('"', vOpen + 1);
        out.push({
          name: m[2],
          range: m[3],
          section,
          line: i,
          nameStart,
          end: vClose + 1,
          versionStart: vOpen + 1,
          versionEnd: vClose,
        });
      }
    }
    depth += countBraces(line);
    if (depth <= 0) section = null;
  }
  return out;
}

export function detectIndent(text: string): string {
  const m = /^([ \t]+)"/m.exec(text);
  return m ? m[1] : '  ';
}

/** Sets section[name] = range, keeping indent, line endings and trailing newline. */
export function addToSection(text: string, section: string, name: string, range: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const obj = JSON.parse(text);
  const keys = section.split(".");
  let target = obj;
  for (const k of keys) target = target[k] = target[k] ?? {};
  target[name] = range;
  let out = JSON.stringify(obj, null, detectIndent(text));
  if (eol === '\r\n') out = out.replace(/\n/g, '\r\n');
  if (/\r?\n$/.test(text)) out += eol;
  return out;
}
