import * as path from 'path';
import * as vscode from 'vscode';
import { PackageManager } from '@core/types';

let installTerminal: vscode.Terminal | undefined;
let installCwd: string | undefined;

/** Scripts and installs execute code from the project, so they need a trusted workspace. */
function trusted(): boolean {
  if (vscode.workspace.isTrusted) return true;
  void vscode.window.showWarningMessage('Trust this workspace to run scripts and installs from Pkg Guard.', 'Manage Trust').then((p) => {
    if (p) void vscode.commands.executeCommand('workbench.trust.manage');
  });
  return false;
}

/**
 * Runs `<pm> run <script>` as a task. The script name comes from package.json, so it is passed as one strongly quoted argument:
 * VS Code quotes it for whichever shell the task uses, and nothing in the name can end the command or start another.
 */
export function runScript(pm: PackageManager, script: string, cwd: string): void {
  if (!trusted()) return;
  const exec = new vscode.ShellExecution(pm.name, ['run', { value: script, quoting: vscode.ShellQuoting.Strong }], { cwd });
  const task = new vscode.Task({ type: 'shell' }, vscode.TaskScope.Workspace, `${script} · ${path.basename(cwd)}`, 'Pkg Guard', exec);
  void vscode.tasks.executeTask(task);
}

export async function install(doc: vscode.TextDocument, pm: PackageManager): Promise<void> {
  if (!trusted()) return;
  await doc.save(); // the install must see the edited package.json
  const cwd = pm.root ?? path.dirname(doc.uri.fsPath);
  // The folder is the terminal's own working directory, never text typed into a shell, so its name cannot be interpreted.
  if (!installTerminal || installTerminal.exitStatus || installCwd !== cwd) {
    installTerminal = vscode.window.createTerminal({ name: 'Pkg Guard', cwd });
    installCwd = cwd;
  }
  installTerminal.show(true);
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
