import type { Section, DepEntry, TextEdit } from './manifest';

/** One Pin: `name` forced to `range` in the manifest's `section` (resolutions / overrides / pnpm.overrides). */
export interface PinRequest {
  section: string;
  name: string;
  range: string;
}

export interface RangeUpdate {
  name: string;
  version: string;
  section?: Section;
}

export type FixEffect =
  /** `file` is set when the edits belong to another manifest than the scanned one (a Pin goes to the workspace root) */
  | { type: 'edit'; edits: TextEdit[]; file?: string }
  | { type: 'setting'; key: 'ignoredAdvisories' | 'ignoredPackages'; value: string }
  | { type: 'install' };

export type Fix =
  | { type: 'setVersion'; title: string; range: string; major?: boolean }
  | { type: 'addOverride'; title: string; section: string; name: string; range: string }
  | { type: 'ignoreAdvisory'; title: string; id: string }
  | { type: 'ignorePackage'; title: string; name: string }
  | { type: 'install'; title: string };

export interface Finding {
  kind: 'vuln' | 'transitive' | 'outdated' | 'deprecated' | 'stale' | 'unsynced';
  entry: DepEntry;
  level: 'error' | 'warning' | 'info';
  message: string;
  code?: string;
  url?: string;
  /** short ghost text shown at the end of the line */
  inline: string;
  fixes: Fix[];
}
