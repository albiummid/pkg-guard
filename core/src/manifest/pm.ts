import * as fs from 'fs';
import * as path from 'path';

export interface PackageManager {
  name: 'npm' | 'yarn' | 'pnpm' | 'bun';
  installCmd: string;
  /** where a transitive pin goes in package.json (dotted path) */
  overrideSection: string;
  /** directory that holds the lockfile (where install must run), if one was found */
  root?: string;
}

const LOCKS: [string, PackageManager['name']][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

function make(name: PackageManager['name'], root?: string): PackageManager {
  return {
    name,
    root,
    installCmd: `${name} install`,
    overrideSection: name === 'yarn' ? 'resolutions' : name === 'pnpm' ? 'pnpm.overrides' : 'overrides',
  };
}

function lockIn(d: string): PackageManager | null {
  for (const [file, name] of LOCKS) if (fs.existsSync(path.join(d, file))) return make(name, d);
  return null;
}

/**
 * Lockfile next to package.json; then the `packageManager` field; then a lockfile in a parent folder
 * (monorepo root); then npm. The field comes before parent folders so a stray lockfile higher up
 * (e.g. in the home directory) cannot override what the project declares.
 */
export function detectPm(dir: string, pkg?: { packageManager?: string }): PackageManager {
  const own = lockIn(dir);
  if (own) return own;
  const declared = /^(npm|yarn|pnpm|bun)@/.exec(pkg?.packageManager ?? '');
  if (declared) return make(declared[1] as PackageManager['name']);
  let d = path.dirname(dir);
  for (;;) {
    const up = lockIn(d);
    if (up) return up;
    const next = path.dirname(d);
    if (next === d) break;
    d = next;
  }
  return make('npm');
}
