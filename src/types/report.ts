import type { BumpKind } from './bump';
import type { CompatReport } from './compat';
import type { Section, PackageManager } from './manifest';

/**
 * safe: patch, or minor on >=1.0.0 (semver says no breaking changes)
 * caution: minor on 0.x, or any non-major bump whose compatibility check found peer / engines problems
 * major: a higher major version, potentially breaking
 */
export type Bucket = 'safe' | 'caution' | 'major';

export interface ReportRow {
  name: string;
  section: Section;
  range: string;
  installed: string;
  target: string;
  kind: BumpKind;
  bucket: Bucket;
  /** the upgrade reaches a version that fixes a known vulnerability */
  fixesVuln: boolean;
  /** peer / engines compatibility was verified against the registry */
  checked: boolean;
  notes: string[];
}

export interface DeprecatedRow {
  name: string;
  installed: string;
  message: string;
}

export interface UpgradeReport {
  title: string;
  pm: PackageManager['name'];
  rows: ReportRow[];
  deprecated: DeprecatedRow[];
  summary: { safe: number; caution: number; major: number; security: number; deprecated: number };
  /** things the reader should know about, e.g. dependencies that could not be checked */
  notes: string[];
}

export type CompatMap = Map<string, CompatReport>;
