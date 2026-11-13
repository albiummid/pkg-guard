import * as fs from 'fs';
import * as vscode from 'vscode';
import { buildFindings } from '@core/analysis/findings';
import { Finding, ScanResult, Settings } from '@core/types';
import { scan } from '@core/analysis/scan';

export interface State {
  /** document version the scan was made from; -1 when scanned from disk */
  version: number;
  result: ScanResult;
  findings: Finding[];
}

export const states = new Map<string, State>();
export const onDidChange = new vscode.EventEmitter<void>();
export const output = vscode.window.createOutputChannel('Pkg Guard');

const pending = new Map<string, Promise<State | undefined>>();
const started = new Map<string, number>();
const committed = new Map<string, number>();

/** Numbers a scan of `key` when it starts. Editor scans and sidebar scans of the same file share this order. */
export function beginScan(key: string): number {
  const n = (started.get(key) ?? 0) + 1;
  started.set(key, n);
  return n;
}

/** Stores the result unless a scan that started later has already stored its own: an older result never replaces a newer one. */
export function commitScan(key: string, seq: number, st: State): boolean {
  if (seq < (committed.get(key) ?? 0)) return false;
  committed.set(key, seq);
  states.set(key, st);
  return true;
}

/** Drops every scan of `key` that is still running (a closed document must not get its diagnostics back). */
export function cancelScans(key: string): void {
  committed.set(key, beginScan(key));
}

export function settings(): Settings {
  const c = vscode.workspace.getConfiguration('pkgGuard');
  return {
    enableVulnerabilities: c.get('enableVulnerabilities', true),
    checkTransitive: c.get('checkTransitive', true),
    enableOutdated: c.get('enableOutdated', true),
    showMajorUpdates: c.get('showMajorUpdates', true),
    checkSync: c.get('checkSync', true),
    minSeverity: c.get('minSeverity', 'low'),
    auditFallback: c.get('auditFallback', true) && vscode.workspace.isTrusted, // runs yarn/npm audit
    registry: c.get('registry', 'https://registry.npmjs.org'),
    ignoredAdvisories: c.get('ignoredAdvisories', []),
    ignoredPackages: c.get('ignoredPackages', []),
  };
}

/** Text of a package.json: the editor buffer when it is open (may be unsaved), else the file on disk. */
export function readText(uri: vscode.Uri): { text: string; version: number } {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (doc) return { text: doc.getText(), version: doc.version };
  return { text: fs.readFileSync(uri.fsPath, 'utf8'), version: -1 };
}

/** Same as readText, without blocking the extension host on a file that is not open. */
async function readTextAsync(uri: vscode.Uri): Promise<{ text: string; version: number }> {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (doc) return { text: doc.getText(), version: doc.version };
  return { text: await fs.promises.readFile(uri.fsPath, 'utf8'), version: -1 };
}

/**
 * Scans one package.json (open or not) and caches the result. Concurrent calls with the same settings share one scan; a call after
 * the settings changed starts its own, so a scan made with the old settings is never handed out as current.
 */
export function scanUri(uri: vscode.Uri): Promise<State | undefined> {
  const key = uri.toString();
  const s = settings();
  const pkey = `${key}|${JSON.stringify(s)}`;
  const running = pending.get(pkey);
  if (running) return running;
  const job = (async () => {
    const seq = beginScan(key);
    try {
      const { text, version } = await readTextAsync(uri);
      const result = await scan(text, uri.fsPath, s);
      const st: State = { version, result, findings: buildFindings(result, s) };
      if (!commitScan(key, seq, st)) return states.get(key); // a newer scan of the same file already stored its result
      for (const n of result.notes) output.appendLine(`[${uri.fsPath}] ${n}`);
      onDidChange.fire();
      return st;
    } catch (e) {
      output.appendLine(`[${uri.fsPath}] scan failed: ${e}`);
      return undefined;
    } finally {
      pending.delete(pkey);
    }
  })();
  pending.set(pkey, job);
  return job;
}

const PROJECT_CAP = 50;
let warnedCap = false;

export async function findProjects(): Promise<vscode.Uri[]> {
  const files = await vscode.workspace.findFiles('**/package.json', '**/node_modules/**', PROJECT_CAP + 1);
  files.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  if (files.length > PROJECT_CAP && !warnedCap) {
    warnedCap = true;
    output.appendLine(`More than ${PROJECT_CAP} package.json files were found; only the first ${PROJECT_CAP} are listed and scanned from disk.`);
  }
  return files.slice(0, PROJECT_CAP);
}
