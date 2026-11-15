import type { DepEntry, PackageManager } from './manifest';
import type { BumpTargets } from './bump';
import type { CompatReport } from './compat';
import type { Finding } from './findings';
import type { UpgradeReport } from './report';
import type { ScanResult } from './scan';

// Replies of the sidecar (src/server.ts) that the JetBrains plugin reads. The Kotlin model in
// platforms/jetbrains/src/main/kotlin/dev/pkgguard/Model.kt must match these and the shapes they name (Finding, Fix,
// FixEffect, TextEdit, ImportFinding, ...); src/test/protocol.test.ts fails when the two disagree.

/** What one package of the scan knows about the registry. */
export interface VersionInfo {
  latest?: string;
  /** stable versions, newest first */
  versions: string[];
  deprecated: Record<string, string>;
}

export interface ScanResponse {
  entries: DepEntry[];
  installed: Record<string, string>;
  findings: Finding[];
  info: Record<string, VersionInfo>;
  bumps: Record<string, BumpTargets>;
  /** stable versions newer than the installed one, newest first, as the core worked them out */
  newer: Record<string, string[]>;
  lock: ScanResult['lock'];
  pm: PackageManager;
  source: ScanResult['source'];
  notes: string[];
}

export interface CompatResponse extends CompatReport {
  text: string;
}

export interface UpgradeReportResponse {
  markdown: string;
  report: UpgradeReport;
}

export interface ChangelogResponse {
  source?: string;
  markdown?: string;
  url?: string;
}

export interface RepoUrlResponse {
  url: string | null;
  npm: string;
}

/** `versions` answers null when the registry does not know the package. */
export interface VersionsResponse {
  latest?: string;
  versions: string[];
  deprecated?: Record<string, string>;
}

/** Params of `removeDependencyEdits`. */
export interface RemoveDependencyParams {
  text: string;
  name: string;
}
