import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildFindings } from '@core/analysis/findings';
import { Finding, ScanResult, Settings } from '@core/types';
import { scan } from '@core/analysis/scan';
import { NpmrcScope } from '@core/sources/npmrc';
import { createScanLedger } from '@core/analysis/scanLedger';

export interface State {
  /** document version the scan was made from; -1 when scanned from disk */
  version: number;
  result: ScanResult;
  findings: Finding[];
}

const ledger = createScanLedger<State>();
export const states = ledger.states;
export const onDidChange = new vscode.EventEmitter<void>();
export const output = vscode.window.createOutputChannel('Pkg Guard');

const pending = new Map<string, Promise<State | undefined>>();

/** Numbers a scan of `key` when it starts. Editor scans and sidebar scans of the same file share this order. */
export const beginScan = ledger.begin;
export const commitScan = ledger.commit;
export const cancelScans = ledger.cancel;

/**
 * Forgets the scan state of package.jsons that no longer exist on disk (deleted or renamed). A manifest that is open in an editor, or
 * that still exists, keeps its state, so nothing the sidebar still shows disappears. Tells the views when something was dropped.
 */
export async function pruneStates(): Promise<void> {
  const open = new Set(vscode.workspace.textDocuments.map((d) => d.uri.toString()));
  const gone = new Set<string>();
  await Promise.all(
    [...states.keys()].filter((k) => !open.has(k)).map((k) => fs.promises.access(vscode.Uri.parse(k).fsPath).catch(() => void gone.add(k))),
  );
  const dropped = ledger.retain((k) => !gone.has(k));
  if (dropped.length) onDidChange.fire();
}

/** `trusted` is a parameter so a test can see the untrusted result: VS Code never reports an untrusted workspace while extension tests run. */
export function settings(trusted = vscode.workspace.isTrusted): Settings {
  const c = vscode.workspace.getConfiguration('pkgGuard');
  return {
    enableVulnerabilities: c.get('enableVulnerabilities', true),
    checkTransitive: c.get('checkTransitive', true),
    enableOutdated: c.get('enableOutdated', true),
    showMajorUpdates: c.get('showMajorUpdates', true),
    checkSync: c.get('checkSync', true),
    minSeverity: c.get('minSeverity', 'low'),
    auditFallback: c.get('auditFallback', true) && trusted, // runs yarn/npm audit
    registry: c.get('registry', 'https://registry.npmjs.org'),
    trusted: vscode.workspace.isTrusted, // a project .npmrc is only read in a trusted workspace
    ignoredAdvisories: c.get('ignoredAdvisories', []),
    ignoredPackages: c.get('ignoredPackages', []),
  };
}

/** Where a registry lookup for a manifest reads .npmrc from; the project's own file only counts in a trusted workspace. */
export function npmrcScope(uri: vscode.Uri): NpmrcScope {
  return { dir: path.dirname(uri.fsPath), trusted: vscode.workspace.isTrusted };
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
