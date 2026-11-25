import type { BumpKind } from './bump';
import type { CompatReport } from './compat';
import type { Section, PackageManager } from './manifest';
import type { Severity } from './vulnerability';

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
  /** the Vulnerability rows (`name@version`) this upgrade fixes, Transitive vulnerabilities included */
  fixes: string[];
  /** peer / engines compatibility was verified against the registry */
  checked: boolean;
  notes: string[];
}

/** One affected copy of a package (package@version) with every Vulnerability found in it, direct or transitive. */
export interface VulnRow {
  name: string;
  version: string;
  /** the copy is a direct dependency; otherwise it is a Transitive vulnerability */
  direct: boolean;
  /** the direct dependencies that pull it in (the package itself when it is direct), sorted */
  parents: string[];
  /** worst Severity of its Advisories */
  severity: Severity;
  advisories: string[];
  fixedIn?: string;
  /** the Fixes available: Updates of direct dependencies and/or a Pin */
  fixes: string[];
  /** why there is no Fix, when `fixes` is empty */
  noFix?: string;
  /** yarn: a resolution scoped to the parent, when no global Pin is offered */
  hint?: string;
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
  /** every Vulnerability the scan's Findings report, one row per package@version */
  vulns: VulnRow[];
  deprecated: DeprecatedRow[];
  /** security: upgrades that fix a Vulnerability; vulnerabilities: known Vulnerabilities (one per Advisory per affected copy) */
  summary: { safe: number; caution: number; major: number; security: number; deprecated: number; vulnerabilities: { direct: number; transitive: number } };
  /** things the reader should know about, e.g. dependencies that could not be checked */
  notes: string[];
  /** dependencies that got no rows, and why */
  unchecked: UncheckedDep[];
}

export interface UncheckedDep {
  name: string;
  reason: 'not installed' | 'registry lookup failed';
}

export type CompatMap = Map<string, CompatReport>;
