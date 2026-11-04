import type { DepEntry, PackageManager } from './manifest';
import type { RegistryInfo } from './registry';
import type { Hit, Graph } from './vulnerability';

export interface Settings {
  enableVulnerabilities: boolean;
  checkTransitive: boolean;
  enableOutdated: boolean;
  showMajorUpdates: boolean;
  /** compare node_modules / lockfile against the declared ranges */
  checkSync: boolean;
  minSeverity: 'low' | 'moderate' | 'high' | 'critical';
  auditFallback: boolean;
  registry: string;
  ignoredAdvisories: string[];
  ignoredPackages: string[];
}

export interface ScanResult {
  entries: DepEntry[];
  installed: Map<string, string>;
  /** where each installed version came from; floor = guessed from the range */
  installedFrom?: Map<string, 'lock' | 'node_modules' | 'floor'>;
  /** version actually present in node_modules */
  onDisk?: Map<string, string>;
  /** a node_modules folder exists next to package.json or in a parent */
  hasNodeModules?: boolean;
  hits: Hit[];
  info: Map<string, RegistryInfo>;
  lock: Graph['kind'];
  pm: PackageManager;
  source: 'osv' | 'audit' | 'none';
  notes: string[];
}
