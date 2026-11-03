import type { Manifest, RegistryInfo } from './registry';

export interface CompatContext {
  /** package.json text and path of the project that owns the dependency */
  text: string;
  pkgFile: string;
  name: string;
  target: string;
  info: RegistryInfo;
  registry: string;
  /** installed versions from the last scan; node_modules is the fallback */
  installed?: Map<string, string>;
}

export interface Dependent {
  /** installed package that declares a peer dependency on the package being updated */
  name: string;
  version: string;
  peerRange: string;
  optional?: boolean;
  /** newest stable version of the dependent whose peer range accepts the target (if any, and newer than `version`) */
  fixedBy?: string;
}

export interface CompatInput {
  name: string;
  installed?: string;
  target: string;
  current?: Manifest;
  next?: Manifest;
  /** version of another package in this project (lockfile / node_modules), if any */
  installedOf: (dep: string) => string | undefined;
  /** engines.node declared by the project, if any */
  projectNode?: string;
  dependents: Dependent[];
}

export interface Issue {
  level: 'error' | 'warning' | 'info';
  text: string;
}

export interface Companion {
  name: string;
  from: string;
  to: string;
  reason: string;
}

export interface CompatReport {
  issues: Issue[];
  companions: Companion[];
}
