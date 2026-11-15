import * as vscode from 'vscode';
import type { TestApi } from '../extension';

export async function activateExtension(): Promise<TestApi> {
  const ext = vscode.extensions.getExtension<TestApi>('albiummid.pkg-guard');
  if (!ext) throw new Error('albiummid.pkg-guard is not loaded');
  return ext.activate();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `check` until it returns something truthy; throws with `what` when it never does. */
export async function until<T>(what: string, check: () => T | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

export function manifestUri(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('no workspace folder');
  return vscode.Uri.joinPath(folder.uri, 'package.json');
}

export const findingsOf = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'pkg-guard');

/**
 * Opens a file in an editor and returns its document. Not workspace.openTextDocument: VS Code keeps a document opened that way
 * alive for a while after its editor is closed, so it would never report the close.
 */
export async function openInEditor(uri: vscode.Uri): Promise<vscode.TextDocument> {
  await vscode.commands.executeCommand('vscode.open', uri);
  return until('the document to open', () => vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()));
}
