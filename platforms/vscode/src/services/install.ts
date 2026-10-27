import * as path from 'path';
import * as vscode from 'vscode';
import { PackageManager } from '@core/manifest/pm';

let installTerminal: vscode.Terminal | undefined;

/** Scripts and installs execute code from the project, so they need a trusted workspace. */
function trusted(): boolean {
  if (vscode.workspace.isTrusted) return true;
  void vscode.window.showWarningMessage('Trust this workspace to run scripts and installs from Pkg Guard.', 'Manage Trust').then((p) => {
    if (p) void vscode.commands.executeCommand('workbench.trust.manage');
  });
  return false;
}

/** Runs `cmd` in a fresh terminal rooted at `cwd`. */
export function runInTerminal(name: string, cwd: string, cmd: string): void {
  if (!trusted()) return;
  const t = vscode.window.createTerminal({ name, cwd });
  t.show(true);
  t.sendText(cmd);
}

export async function install(doc: vscode.TextDocument, pm: PackageManager): Promise<void> {
  if (!trusted()) return;
  await doc.save(); // the install must see the edited package.json
  const cwd = pm.root ?? path.dirname(doc.uri.fsPath);
  if (!installTerminal || installTerminal.exitStatus) installTerminal = vscode.window.createTerminal({ name: 'Pkg Guard', cwd });
  installTerminal.show(true);
  installTerminal.sendText(`cd "${cwd}"`);
  installTerminal.sendText(pm.installCmd);
}

/** Asks (or not, per `pkgGuard.installAfterFix`) whether to run the package manager's install. */
export async function offerInstall(doc: vscode.TextDocument, pm: PackageManager): Promise<void> {
  const mode = vscode.workspace.getConfiguration('pkgGuard').get<string>('installAfterFix', 'ask');
  if (mode === 'never') return;
  if (mode === 'auto') return install(doc, pm);
  const run = `Save & run ${pm.installCmd}`;
  const pick = await vscode.window.showInformationMessage(`package.json updated. Run ${pm.name} to update node_modules and the lockfile?`, run, 'Later');
  if (pick === run) await install(doc, pm);
}
