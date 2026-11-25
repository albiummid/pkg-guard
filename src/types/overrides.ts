/**
 * still-needed: without the entry, a requester would get a version with an Advisory
 * redundant: without it, every requester would get a version with no known Advisory
 * forces-other-major: it moves a requester that would be clean on its own onto another major
 * unused: nothing in the lockfile requests the package
 * not-checked: the audit could not judge it (lockfile format, nested override, failed lookup)
 */
export type OverrideVerdict = 'still-needed' | 'redundant' | 'forces-other-major' | 'unused' | 'not-checked';

/** One range other packages request for an overridden package, and what it would resolve to without the override. */
export interface OverrideRequest {
  range: string;
  /** names of the packages asking for it; '' is the project itself */
  by: string[];
  /** newest published version the range allows */
  fresh?: string;
  /** Advisory ids affecting `fresh` */
  advisories: string[];
  /** the overridden version is in a different major than every version this range allows */
  otherMajor: boolean;
}

/** One key of the package manager's override section, judged. */
export interface OverrideRow {
  key: string;
  /** the package the key overrides */
  name: string;
  value: string;
  verdict: OverrideVerdict;
  /** the version the override installs (newest published version its value allows) */
  forced?: string;
  requests: OverrideRequest[];
  /** why it was not checked */
  reason?: string;
}

/** Audit of the project's `resolutions` / `overrides`, computed during report generation and passed into report building. */
export interface OverrideAudit {
  /** where the entries live: `resolutions`, `overrides` or `pnpm.overrides` */
  section: string;
  lockfile: 'yarn-classic' | 'yarn-berry' | 'npm' | 'pnpm' | 'bun' | 'none';
  rows: OverrideRow[];
}
