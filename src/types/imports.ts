import type { DepEntry } from './manifest';
import type { Finding } from './findings';

/** A bare package specifier in an import / require / export-from of a source file. */
export interface ImportRef {
  /** package name: first path segment, or `@scope/pkg` */
  name: string;
  line: number;
  /** column of the opening quote of the specifier */
  start: number;
  /** column just after the closing quote */
  end: number;
}

/** What one package.json contributes to the import warnings of a source file below it. */
export interface ManifestFindings {
  entries: DepEntry[];
  findings: Finding[];
}

/** The vulnerability Findings of the package an import refers to. */
export interface ImportFinding {
  ref: ImportRef;
  level: Finding['level'];
  message: string;
  inline: string;
  code?: string;
  url?: string;
}
