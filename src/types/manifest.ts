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

export interface KeyLoc {
  key: string;
  line: number;
}

export interface PackageManager {
  name: 'npm' | 'yarn' | 'pnpm' | 'bun';
  installCmd: string;
  /** where a transitive pin goes in package.json (dotted path) */
  overrideSection: string;
  /** directory that holds the lockfile (where install must run), if one was found */
  root?: string;
}

/** A text replacement; 0-based line / column, end exclusive. */
export interface TextEdit {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  newText: string;
}
