import type { DepEntry, PackageManager } from './manifest';
import type { RegistryInfo } from './registry';
import type { Hit, Graph } from './vulnerability';

export interface Settings {
  enableVulnerabilities: boolean;
  checkTransitive: boolean;
  enableOutdated: boolean;
  showMajorUpdates: boolean;
  minSeverity: 'low' | 'moderate' | 'high' | 'critical';
  auditFallback: boolean;
  registry: string;
  ignoredAdvisories: string[];
  ignoredPackages: string[];
}

export interface ScanResult {
  entries: DepEntry[];
  installed: Map<string, string>;
  hits: Hit[];
  info: Map<string, RegistryInfo>;
  lock: Graph['kind'];
  pm: PackageManager;
  source: 'osv' | 'audit' | 'none';
  notes: string[];
}
