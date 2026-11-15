import * as assert from 'assert';
import * as vscode from 'vscode';
import { activateExtension, findingsOf, manifestUri, openInEditor, sleep, until } from './helpers';

const SCHEME = 'pkg-guard-test';

suite('workspace with a package.json', () => {
  let registration: vscode.Disposable;
  suiteSetup(() => {
    registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      provideTextDocumentContent: () => JSON.stringify({ name: 'old', dependencies: { 'left-pad': '^1.0.0' } }, null, 2),
    });
  });
  suiteTeardown(() => registration.dispose());
  teardown(() => vscode.commands.executeCommand('workbench.action.closeAllEditors'));

  test('workspace settings that choose the registry or run commands are honoured', async () => {
    const api = await activateExtension();
    assert.strictEqual(vscode.workspace.isTrusted, true);
    assert.strictEqual(api.settings().registry, 'http://workspace.invalid');
    assert.strictEqual(vscode.workspace.getConfiguration('pkgGuard').get('installAfterFix'), 'auto');
  });

  // VS Code never reports an untrusted workspace while extension tests run, so the untrusted side is checked at its two seams:
  // what the manifest tells VS Code to ignore, and what the extension does when told it is untrusted.
  test('the manifest restricts the registry, install-after-fix and audit-fallback settings in an untrusted workspace', () => {
    const ext = vscode.extensions.getExtension('albiummid.pkg-guard')!;
    assert.deepStrictEqual(
      [...ext.packageJSON.capabilities.untrustedWorkspaces.restrictedConfigurations].sort(),
      ['pkgGuard.auditFallback', 'pkgGuard.installAfterFix', 'pkgGuard.registry'],
    );
    assert.strictEqual(ext.packageJSON.capabilities.untrustedWorkspaces.supported, 'limited');
  });

  test('the audit fallback stays off when the workspace is untrusted', async () => {
    const api = await activateExtension();
    assert.strictEqual(api.settings(true).auditFallback, true);
    assert.strictEqual(api.settings(false).auditFallback, false);
  });

  test('granting trust re-scans the open package.json', async () => {
    const api = await activateExtension();
    const uri = manifestUri();
    await openInEditor(uri);
    const first = await until('the first scan', () => api.states.get(uri.toString()));
    // a test cannot make VS Code grant trust, so this runs what its onDidGrantWorkspaceTrust listener runs
    api.onTrustGranted();
    await until('a new scan after trust was granted', () => api.states.get(uri.toString()) !== first);
  });

  test('an opened package.json gets Findings', async () => {
    await activateExtension();
    const uri = manifestUri();
    await openInEditor(uri);
    await until('a Finding for the fixture dependency', () => findingsOf(uri).length > 0);
  });

  test('a diff view of a package.json gets no Findings', async () => {
    const api = await activateExtension();
    const real = manifestUri();
    const old = vscode.Uri.parse(`${SCHEME}:/package.json`);
    await vscode.commands.executeCommand('vscode.diff', old, real, 'package.json (diff)');
    // the file side is an ordinary package.json and is scanned; the other side must not be
    await until('the file side to be scanned', () => findingsOf(real).length > 0);
    await sleep(1000);
    assert.deepStrictEqual(findingsOf(old), []);
    assert.strictEqual(api.states.has(old.toString()), false);
  });

  test('an untitled package.json gets no Findings', async () => {
    const api = await activateExtension();
    const doc = await vscode.workspace.openTextDocument({ language: 'json', content: '{ "dependencies": { "left-pad": "^1.0.0" } }' });
    await vscode.window.showTextDocument(doc);
    await sleep(1000);
    assert.deepStrictEqual(findingsOf(doc.uri), []);
    assert.strictEqual(api.states.has(doc.uri.toString()), false);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor'); // closing a dirty untitled file would ask to save
  });

  test('a closed document does not get its diagnostics back from a scan still running', async () => {
    const api = await activateExtension();
    const uri = manifestUri();
    await openInEditor(uri);
    await until('a Finding', () => findingsOf(uri).length > 0);
    const scanning = api.scanOpen(uri);
    await vscode.window.tabGroups.close(vscode.window.tabGroups.all.flatMap((g) => g.tabs));
    await until('the document to be closed', () => !vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString()), 10_000);
    await scanning;
    await sleep(500);
    assert.deepStrictEqual(findingsOf(uri), []);
  });

  test('a scan dropped by cancelScans is never committed', async () => {
    const api = await activateExtension();
    const key = 'file:///cancelled/package.json';
    const state = api.states.get(manifestUri().toString())!;
    const seq = api.beginScan(key);
    api.cancelScans(key);
    assert.strictEqual(api.commitScan(key, seq, state), false);
    assert.strictEqual(api.states.has(key), false);
  });

  test('an older scan result never replaces a newer one', async () => {
    const api = await activateExtension();
    const key = 'file:///ordered/package.json';
    const base = api.states.get(manifestUri().toString())!;
    const older = { ...base, version: 1 };
    const newer = { ...base, version: 2 };
    const first = api.beginScan(key);
    const second = api.beginScan(key);
    assert.strictEqual(api.commitScan(key, second, newer), true);
    assert.strictEqual(api.commitScan(key, first, older), false, 'the scan that started first finished last');
    assert.strictEqual(api.states.get(key), newer);
  });
});
