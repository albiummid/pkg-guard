import * as fs from 'fs';
import * as vscode from 'vscode';
import { Finding, buildFindings } from './findings';
import { scan, ScanResult, Settings } from './scan';

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

export function settings(): Settings {
  const c = vscode.workspace.getConfiguration('pkgGuard');
  return {
    enableVulnerabilities: c.get('enableVulnerabilities', true),
    checkTransitive: c.get('checkTransitive', true),
    enableOutdated: c.get('enableOutdated', true),
    showMajorUpdates: c.get('showMajorUpdates', true),
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

/** Scans one package.json (open or not) and caches the result. Concurrent calls share one scan. */
export function scanUri(uri: vscode.Uri): Promise<State | undefined> {
  const key = uri.toString();
  const running = pending.get(key);
  if (running) return running;
  const job = (async () => {
    try {
      const { text, version } = readText(uri);
      const s = settings();
      const result = await scan(text, uri.fsPath, s);
      const st: State = { version, result, findings: buildFindings(result, s) };
      states.set(key, st);
      for (const n of result.notes) output.appendLine(`[${uri.fsPath}] ${n}`);
      onDidChange.fire();
      return st;
    } catch (e) {
      output.appendLine(`[${uri.fsPath}] scan failed: ${e}`);
      return undefined;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, job);
  return job;
}

export async function findProjects(): Promise<vscode.Uri[]> {
  const files = await vscode.workspace.findFiles('**/package.json', '**/node_modules/**', 50);
  return files.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
}
