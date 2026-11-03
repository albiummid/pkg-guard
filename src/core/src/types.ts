export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'unknown';

export const SEVERITY_RANK: Record<Severity, number> = { unknown: 2, low: 1, moderate: 2, high: 3, critical: 4 };

export interface Vuln {
  id: string;
  url: string;
  summary: string;
  severity: Severity;
  fixedIn?: string;
  pkg: string;
  version: string;
}

/** A vulnerability attributed to a direct dependency (path.length === 1 means the dependency itself). */
export interface Hit {
  root: string;
  path: string[];
  vuln: Vuln;
}

export interface GNode {
  id: string;
  name: string;
  version: string;
  deps: string[];
}

export interface Graph {
  kind: 'yarn' | 'npm' | 'none';
  nodes: Map<string, GNode>;
  /** direct dependency name -> node id */
  roots: Map<string, string>;
}
