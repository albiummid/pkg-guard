import type { Manifest, RegistryInfo } from './registry';

export interface CompatContext {
  /** package.json text and path of the project that owns the dependency */
  text: string;
  pkgFile: string;
  name: string;
  target: string;
  info: RegistryInfo;
  registry: string;
  /** see Settings.trusted */
  trusted?: boolean;
  /** installed versions from the last scan; node_modules is the fallback */
  installed?: Map<string, string>;
  /** registry data from the last scan; gives dependents' peer ranges when node_modules is absent */
  infos?: Map<string, RegistryInfo>;
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

/** A package and the peer range involved in a Compatibility issue. */
export interface PeerRef {
  name: string;
  range: string;
}

export interface Issue {
  level: 'error' | 'warning' | 'info';
  text: string;
  /** the peer the target needs, so the upgrade report can tell when another upgrade meets it */
  peer?: PeerRef;
  /** the installed dependent whose peer range on this package rejects the target */
  dependent?: PeerRef;
  /** the Installed version has the same problem, so the upgrade changes nothing (level is info) */
  alreadyTheCase?: boolean;
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
