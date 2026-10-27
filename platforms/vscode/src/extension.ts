import * as vscode from 'vscode';
import { registerCommands } from './commands/commands';
import { fixEffect } from '@core/fixes/fixes';
import { Finding, Fix, buildFindings } from '@core/scan/findings';
import { offerInstall } from './services/install';
import { clearOsvCache } from '@core/vulnerabilities/osv';
import { clearRegistryCache } from '@core/updates/registry';
import { scan, ScanResult } from '@core/scan/scan';
import { findProjects, onDidChange, output, scanUri, settings, states } from './services/store';
import { PackagesTree } from './views/tree';

const inflight = new Map<string, number>();
const timers = new Map<string, NodeJS.Timeout>();

let diagnostics: vscode.DiagnosticCollection;
let status: vscode.StatusBarItem;
const decos = {
  error: vscode.window.createTextEditorDecorationType({}),
  warning: vscode.window.createTextEditorDecorationType({}),
  info: vscode.window.createTextEditorDecorationType({}),
};

function isPackageJson(doc: vscode.TextDocument): boolean {
  return /[\\/]package\.json$/.test(doc.fileName) && !/[\\/]node_modules[\\/]/.test(doc.fileName);
}

function toSeverity(s: Finding['severity']): vscode.DiagnosticSeverity {
  return s === 'error' ? vscode.DiagnosticSeverity.Error : s === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
}

function schedule(doc: vscode.TextDocument, delay = 300): void {
  if (!isPackageJson(doc)) return;
  const key = doc.uri.toString();
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => void run(doc), delay));
}

async function run(doc: vscode.TextDocument): Promise<void> {
  const key = doc.uri.toString();
  const ticket = (inflight.get(key) ?? 0) + 1;
  inflight.set(key, ticket);
  const version = doc.version;
  const s = settings();
  status.text = '$(sync~spin) Pkg Guard';
  status.show();
  let result: ScanResult;
  try {
    result = await scan(doc.getText(), doc.uri.fsPath, s);
  } catch (e) {
    output.appendLine(`[${doc.fileName}] scan failed: ${e}`);
    return;
  }
  if (inflight.get(key) !== ticket) return; // superseded by a newer scan
  const findings = buildFindings(result, s);
  states.set(key, { version, result, findings });
  for (const n of result.notes) output.appendLine(`[${doc.fileName}] ${n}`);
  onDidChange.fire(); // the sidebar reads the same state
  publish(doc);
  updateStatus(vscode.window.activeTextEditor);
}

function publish(doc: vscode.TextDocument): void {
  const st = states.get(doc.uri.toString());
  if (!st) return;
  diagnostics.set(
    doc.uri,
    st.findings.map((f) => {
      const d = new vscode.Diagnostic(
        new vscode.Range(f.entry.line, f.entry.nameStart, f.entry.line, f.entry.end),
        f.message,
        toSeverity(f.severity),
      );
      d.source = 'pkg-guard';
      if (f.code && f.url) d.code = { value: f.code, target: vscode.Uri.parse(f.url) };
      return d;
    }),
  );
  for (const ed of vscode.window.visibleTextEditors) if (ed.document === doc) decorate(ed);
}

const RANK = { error: 3, warning: 2, info: 1 } as const;

function decorate(ed: vscode.TextEditor): void {
  const st = states.get(ed.document.uri.toString());
  const buckets: Record<Finding['severity'], vscode.DecorationOptions[]> = { error: [], warning: [], info: [] };
  if (st && st.version === ed.document.version) {
    const byLine = new Map<number, Finding[]>();
    for (const f of st.findings) byLine.set(f.entry.line, [...(byLine.get(f.entry.line) ?? []), f]);
    for (const [line, fs] of byLine) {
      const worst = fs.reduce((a, b) => (RANK[b.severity] > RANK[a.severity] ? b : a)).severity;
      const text = fs
        .sort((a, b) => RANK[b.severity] - RANK[a.severity])
        .map((f) => f.inline)
        .join('  ');
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = { enabledCommands: ['pkgGuard.applyFix'] };
      fs.forEach((f, fi) => {
        md.appendText(f.message + '\n');
        f.fixes.forEach((fx, xi) => {
          const args = encodeURIComponent(JSON.stringify([ed.document.uri.toString(), line, fi, xi]));
          md.appendMarkdown(`\n[${fx.title}](command:pkgGuard.applyFix?${args})\n`);
        });
        md.appendMarkdown('\n---\n');
      });
      buckets[worst].push({
        range: new vscode.Range(line, ed.document.lineAt(line).text.length, line, ed.document.lineAt(line).text.length),
        hoverMessage: md,
        renderOptions: { after: { contentText: `   ${text}`, fontStyle: 'italic', color: new vscode.ThemeColor(worst === 'error' ? 'editorError.foreground' : worst === 'warning' ? 'editorWarning.foreground' : 'editorCodeLens.foreground') } },
      });
    }
  }
  ed.setDecorations(decos.error, buckets.error);
  ed.setDecorations(decos.warning, buckets.warning);
  ed.setDecorations(decos.info, buckets.info);
}

function updateStatus(ed: vscode.TextEditor | undefined): void {
  const st = ed && isPackageJson(ed.document) ? states.get(ed.document.uri.toString()) : undefined;
  if (!st) {
    status.hide();
    return;
  }
  const vulns = st.findings.filter((f) => f.kind === 'vuln' || f.kind === 'transitive').length;
  const updates = st.findings.filter((f) => f.kind === 'outdated').length;
  status.text = `$(shield) ${vulns} vulnerable · ${updates} updates`;
  status.tooltip = `Pkg Guard (${st.result.source === 'audit' ? 'audit CLI' : st.result.source === 'osv' ? 'OSV.dev' : 'no vulnerability data'}) — click to re-scan`;
  status.backgroundColor = vulns ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  status.show();
}

async function applyFix(doc: vscode.TextDocument, f: Finding, fx: Fix): Promise<void> {
  const effect = fixEffect(doc.getText(), f.entry, fx);
  if (effect.type === 'setting') {
    const cfg = vscode.workspace.getConfiguration('pkgGuard');
    await cfg.update(effect.key, [...new Set([...cfg.get<string[]>(effect.key, []), effect.value])], vscode.ConfigurationTarget.Workspace);
    return;
  }
  const we = new vscode.WorkspaceEdit();
  for (const e of effect.edits) we.replace(doc.uri, doc.validateRange(new vscode.Range(e.startLine, e.startChar, e.endLine, e.endChar)), e.newText);
  await vscode.workspace.applyEdit(we);
  const pm = states.get(doc.uri.toString())?.result.pm;
  if (pm) await offerInstall(doc, pm);
}

class Fixer implements vscode.CodeActionProvider {
  provideCodeActions(doc: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
    const st = states.get(doc.uri.toString());
    if (!st || st.version !== doc.version) return [];
    const acts: vscode.CodeAction[] = [];
    for (const f of st.findings) {
      if (f.entry.line < range.start.line || f.entry.line > range.end.line) continue;
      for (const fx of f.fixes) {
        const a = new vscode.CodeAction(fx.title, fx.type === 'setVersion' || fx.type === 'addOverride' ? vscode.CodeActionKind.QuickFix : vscode.CodeActionKind.Empty);
        a.isPreferred = fx.type === 'setVersion' && f.kind === 'vuln';
        a.command = { command: 'pkgGuard.runFix', title: fx.title, arguments: [doc.uri.toString(), f.entry.line, f.kind, f.message, fx] };
        acts.push(a);
      }
    }
    return acts;
  }
}

export function activate(ctx: vscode.ExtensionContext): void {
  diagnostics = vscode.languages.createDiagnosticCollection('pkg-guard');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.command = 'pkgGuard.refresh';
  ctx.subscriptions.push(diagnostics, output, status, decos.error, decos.warning, decos.info, onDidChange);

  const tree = new PackagesTree();
  ctx.subscriptions.push(vscode.window.createTreeView('pkgGuard.packages', { treeDataProvider: tree, showCollapseAll: true }));

  const refreshAll = (clear: boolean) => {
    if (clear) {
      clearOsvCache();
      clearRegistryCache();
    }
    const open = new Set<string>();
    for (const d of vscode.workspace.textDocuments) {
      if (isPackageJson(d)) open.add(d.uri.toString());
      schedule(d, 0);
    }
    // projects whose package.json is not open are scanned from disk for the sidebar
    void findProjects().then((files) => files.filter((u) => !open.has(u.toString())).forEach((u) => void scanUri(u)));
    tree.refresh();
  };
  registerCommands(ctx, () => refreshAll(true));

  ctx.subscriptions.push(
    vscode.commands.registerCommand('pkgGuard.refresh', () => refreshAll(true)),
    vscode.commands.registerCommand('pkgGuard.runFix', async (uri: string, line: number, kind: string, message: string, fx: Fix) => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      const f = states.get(uri)?.findings.find((x) => x.entry.line === line && x.kind === kind && x.message === message);
      if (f) await applyFix(doc, f, fx);
    }),
    vscode.commands.registerCommand('pkgGuard.applyFix', async (uri: string, line: number, fi: number, xi: number) => {
      const st = states.get(uri);
      const lineFindings = st?.findings.filter((x) => x.entry.line === line).sort((a, b) => RANK[b.severity] - RANK[a.severity]);
      const f = lineFindings?.[fi];
      const fx = f?.fixes[xi];
      if (!f || !fx) return;
      await applyFix(await vscode.workspace.openTextDocument(vscode.Uri.parse(uri)), f, fx);
    }),
    vscode.languages.registerCodeActionsProvider({ pattern: '**/package.json' }, new Fixer(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.workspace.onDidOpenTextDocument((d) => schedule(d, 0)),
    vscode.workspace.onDidSaveTextDocument((d) => schedule(d, 0)),
    // keep the state: the sidebar still shows this project
    vscode.workspace.onDidCloseTextDocument((d) => diagnostics.delete(d.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('pkgGuard') && refreshAll(false)),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      updateStatus(ed);
      if (ed && isPackageJson(ed.document)) {
        // a scan made from disk (version -1) has no editor positions yet
        if (states.get(ed.document.uri.toString())?.version !== ed.document.version) schedule(ed.document, 0);
        else decorate(ed);
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors((eds) => eds.forEach(decorate)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isPackageJson(e.document)) for (const ed of vscode.window.visibleTextEditors) if (ed.document === e.document) decorate(ed);
    }),
  );

  const watcher = vscode.workspace.createFileSystemWatcher('**/{yarn.lock,package-lock.json,pnpm-lock.yaml,package.json}');
  let watchTimer: NodeJS.Timeout | undefined;
  const onFile = (u: vscode.Uri) => {
    if (/[\\/]node_modules[\\/]/.test(u.fsPath)) return;
    clearTimeout(watchTimer); // an install touches many files at once
    watchTimer = setTimeout(() => refreshAll(false), 500);
  };
  watcher.onDidChange(onFile);
  watcher.onDidCreate(onFile);
  watcher.onDidDelete(onFile);
  ctx.subscriptions.push(watcher);

  refreshAll(false);
}

export function deactivate(): void {
  for (const t of timers.values()) clearTimeout(t);
}
