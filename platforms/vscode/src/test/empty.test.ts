import * as assert from 'assert';
import * as vscode from 'vscode';
import { activateExtension } from './helpers';

suite('empty workspace', () => {
  test('the Packages view contributes its welcome content', () => {
    const ext = vscode.extensions.getExtension('albiummid.pkg-guard')!;
    const welcome = (ext.packageJSON.contributes.viewsWelcome as { view: string; contents: string }[]).find((w) => w.view === 'pkgGuard.packages');
    assert.ok(welcome?.contents, 'viewsWelcome has an entry for pkgGuard.packages');
  });

  test('the view has no children, so VS Code shows the welcome content', async () => {
    // opening the view is what activates the extension in a folder with no package.json
    await vscode.commands.executeCommand('pkgGuard.packages.focus');
    const api = await activateExtension();
    assert.deepStrictEqual(await api.tree.getChildren(), []);
  });
});
