import type { Section, DepEntry, TextEdit } from './manifest';

export interface RangeUpdate {
  name: string;
  version: string;
  section?: Section;
}

export type FixEffect =
  | { type: 'edit'; edits: TextEdit[] }
  | { type: 'setting'; key: 'ignoredAdvisories' | 'ignoredPackages'; value: string };

export type Fix =
  | { type: 'setVersion'; title: string; range: string; major?: boolean }
  | { type: 'addOverride'; title: string; section: string; name: string; range: string }
  | { type: 'ignoreAdvisory'; title: string; id: string }
  | { type: 'ignorePackage'; title: string; name: string };

export interface Finding {
  kind: 'vuln' | 'transitive' | 'outdated' | 'deprecated';
  entry: DepEntry;
  level: 'error' | 'warning' | 'info';
  message: string;
  code?: string;
  url?: string;
  /** short ghost text shown at the end of the line */
  inline: string;
  fixes: Fix[];
}
