export interface Manifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  engines?: { node?: string };
  deprecated?: string;
}

export interface RegistryInfo {
  latest?: string;
  versions: string[];
  deprecated: Record<string, string>;
  manifests: Record<string, Manifest>;
}

export interface Suggestion {
  /** newest stable version with the same major as installed (only if newer than installed) */
  inMajor?: string;
  /** newest stable version overall, only if it crosses a major */
  nextMajor?: string;
}

export interface RepoRef {
  url: string;
  directory?: string;
  host?: 'github';
  owner?: string;
  repo?: string;
}

export interface PackageMeta {
  repo: RepoRef | null;
  homepage?: string;
  bugs?: string;
}
