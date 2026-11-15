import * as assert from 'assert';
import * as vscode from 'vscode';
import type { TestApi } from '../extension';
import { until } from './helpers';

suite('package.json opened without a folder', () => {
  test('activates the extension and scans the file', async () => {
    assert.strictEqual(vscode.workspace.workspaceFolders, undefined, 'launched with a file, not a folder');
    const ext = vscode.extensions.getExtension<TestApi>('albiummid.pkg-guard')!;
    // nothing but onLanguage:json can have activated it: with no folder, workspaceContains never fires
    await until('the extension to activate', () => ext.isActive);
    const doc = await until('the package.json to be open', () => vscode.workspace.textDocuments.find((d) => d.fileName.endsWith('package.json')));
    await until('the file to be scanned', () => ext.exports.states.has(doc.uri.toString()));
  });
});
