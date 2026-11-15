import * as vscode from 'vscode';
import { registerCommands } from './commands/commands';
import { fixEffect } from '@core/analysis/fixes';
import { buildFindings } from '@core/analysis/findings';
import { Finding, Fix, ScanResult } from '@core/types';
import { install, offerInstall } from './services/install';
import { clearOsvCache } from '@core/sources/osv';
import { clearRegistryCache } from '@core/sources/registry';
import { scan } from '@core/analysis/scan';
import { beginScan, cancelScans, commitScan, findProjects, onDidChange, output, scanUri, settings, states } from './services/store';
import { PackagesTree } from './views/tree';
import { registerImportWarnings } from './views/imports';

const timers = new Map<string, NodeJS.Timeout>();
/** documents whose scan is running right now */
const running = new Set<string>();

let diagnostics: vscode.DiagnosticCollection;
let status: vscode.StatusBarItem;
const decos = {
  error: vscode.window.createTextEditorDecorationType({}),
  warning: vscode.window.createTextEditorDecorationType({}),
  info: vscode.window.createTextEditorDecorationType({}),
};

/** A real package.json on disk: not a node_modules copy, and not a git / diff / untitled view of one. */
function isPackageJson(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === 'file' && /[\\/]package\.json$/.test(doc.fileName) && !/[\\/]node_modules[\\/]/.test(doc.fileName);
}

/** Escapes Markdown syntax in text that came from package.json or an advisory, so it renders as written. */
function escapeMarkdown(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}

function toSeverity(s: Finding['level']): vscode.DiagnosticSeverity {
  return s === 'error' ? vscode.DiagnosticSeverity.Error : s === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
}

function schedule(doc: vscode.TextDocument, delay = 300): void {
  if (!isPackageJson(doc)) return;
  const key = doc.uri.toString();
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      void run(doc);
    }, delay),
  );
}

async function run(doc: vscode.TextDocument): Promise<void> {
  const key = doc.uri.toString();
  const seq = beginScan(key);
  const version = doc.version;
  const s = settings();
  running.add(key);
  status.text = '$(sync~spin) Pkg Guard';
  status.show();
  let result: ScanResult;
  try {
    result = await scan(doc.getText(), doc.uri.fsPath, s);
  } catch (e) {
    output.appendLine(`[${doc.fileName}] scan failed: ${e}`);
    running.delete(key);
    updateStatus(vscode.window.activeTextEditor); // leave the busy spinner
    return;
  }
  running.delete(key);
  const findings = buildFindings(result, s);
  // superseded by a newer scan (an edit, a re-scan, or the document was closed): its result is the newer one's to publish
  if (!commitScan(key, seq, { version, result, findings })) {
    updateStatus(vscode.window.activeTextEditor);
    return;
  }
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
        toSeverity(f.level),
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
  const buckets: Record<Finding['level'], vscode.DecorationOptions[]> = { error: [], warning: [], info: [] };
  if (st && st.version === ed.document.version) {
    const byLine = new Map<number, Finding[]>();
    for (const f of st.findings) byLine.set(f.entry.line, [...(byLine.get(f.entry.line) ?? []), f]);
    for (const [line, fs] of byLine) {
      const worst = fs.reduce((a, b) => (RANK[b.level] > RANK[a.level] ? b : a)).level;
      const text = fs
        .sort((a, b) => RANK[b.level] - RANK[a.level])
        .map((f) => f.inline)
        .join('  ');
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = { enabledCommands: ['pkgGuard.applyFix'] };
      fs.forEach((f) => {
        md.appendText(f.message + '\n');
        for (const fx of f.fixes) {
          // the link names the Finding and the Fix itself, not their position in a list that a re-scan may have reordered
          const args = encodeURIComponent(JSON.stringify([ed.document.uri.toString(), line, f.kind, f.message, fx]));
          md.appendMarkdown(`\n[${escapeMarkdown(fx.title)}](command:pkgGuard.applyFix?${args})\n`);
        }
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
  const effect = fixEffect(doc.getText(), f.entry, fx, doc.uri.fsPath);
  if (effect.type === 'setting') {
    const cfg = vscode.workspace.getConfiguration('pkgGuard');
    // only the workspace's own list: get() would merge in the user's list and copy it into shared workspace settings
    const own = cfg.inspect<string[]>(effect.key)?.workspaceValue ?? [];
    await cfg.update(effect.key, [...new Set([...own, effect.value])], vscode.ConfigurationTarget.Workspace);
    return;
  }
  const st = states.get(doc.uri.toString());
  const pm = st?.result.pm;
  if (effect.type === 'install') {
    if (pm) await install(doc, pm);
    return;
  }
  // The edit positions come from the scan: refuse when the document changed since, instead of editing the wrong text.
  if (fx.type === 'setVersion') {
    const at = doc.getText(new vscode.Range(f.entry.line, f.entry.versionStart, f.entry.line, f.entry.versionEnd));
    if (st?.version !== doc.version || at !== f.entry.range) {
      void vscode.window.showWarningMessage('package.json changed since it was scanned. Wait for the re-scan and try again.');
      return;
    }
  }
  const target = effect.file ? await vscode.workspace.openTextDocument(vscode.Uri.file(effect.file)) : doc;
  if (effect.file && target.isDirty) {
    void vscode.window.showWarningMessage(`Save ${vscode.workspace.asRelativePath(target.uri)} first: ${fx.title} is written there.`);
    return;
  }
  const we = new vscode.WorkspaceEdit();
  for (const e of effect.edits) we.replace(target.uri, target.validateRange(new vscode.Range(e.startLine, e.startChar, e.endLine, e.endChar)), e.newText);
  await vscode.workspace.applyEdit(we);
  if (effect.file) await target.save(); // a pin lives in the workspace root's package.json; the install must see it
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
        const a = new vscode.CodeAction(fx.title, vscode.CodeActionKind.QuickFix);
        a.isPreferred = (fx.type === 'setVersion' && f.kind === 'vuln') || (fx.type === 'install' && f.kind === 'unsynced');
        a.command = { command: 'pkgGuard.runFix', title: fx.title, arguments: [doc.uri.toString(), f.entry.line, f.kind, f.message, fx] };
        acts.push(a);
      }
    }
    return acts;
  }
}

export function activate(ctx: vscode.ExtensionContext): void {
  diagnostics = vscode.languages.createDiagnosticCollection('pkg-guard');
  status = vscode.window.createStatusBarItem('pkgGuard.status', vscode.StatusBarAlignment.Left, 0);
  status.name = 'Pkg Guard';
  status.command = 'pkgGuard.refresh';
  ctx.subscriptions.push(diagnostics, output, status, decos.error, decos.warning, decos.info, onDidChange);

  const tree = new PackagesTree();
  ctx.subscriptions.push(tree, vscode.window.createTreeView('pkgGuard.packages', { treeDataProvider: tree, showCollapseAll: true }));

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
  // "Re-scan" of one project fetches fresh advisory and registry data and republishes an open editor, like the global refresh does
  registerCommands(
    ctx,
    () => refreshAll(true),
    (uri) => {
      clearOsvCache();
      clearRegistryCache();
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      if (doc && isPackageJson(doc)) schedule(doc, 0);
      else void scanUri(uri);
      tree.refresh();
    },
  );

  // new advisories are published all the time; without this a window left open never sees them
  let periodic: NodeJS.Timeout | undefined;
  const schedulePeriodic = () => {
    clearInterval(periodic);
    const hours = Math.min(vscode.workspace.getConfiguration('pkgGuard').get('refreshIntervalHours', 6), 168);
    periodic = hours > 0 ? setInterval(() => refreshAll(true), hours * 3_600_000) : undefined;
  };
  schedulePeriodic();
  ctx.subscriptions.push({ dispose: () => clearInterval(periodic) });
  registerImportWarnings(ctx);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('pkgGuard.refresh', () => refreshAll(true)),
    vscode.commands.registerCommand('pkgGuard.runFix', async (uri: string, line: number, kind: string, message: string, fx: Fix) => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      const f = states.get(uri)?.findings.find((x) => x.entry.line === line && x.kind === kind && x.message === message);
      if (f) await applyFix(doc, f, fx);
    }),
    vscode.commands.registerCommand('pkgGuard.applyFix', async (uri: string, line: number, kind: string, message: string, fx: Fix) => {
      const f = states.get(uri)?.findings.find((x) => x.entry.line === line && x.kind === kind && x.message === message);
      if (!f) return void vscode.window.showWarningMessage('The findings changed since this hover was shown. Hover the line again.');
      await applyFix(await vscode.workspace.openTextDocument(vscode.Uri.parse(uri)), f, fx);
    }),
    vscode.languages.registerCodeActionsProvider({ scheme: 'file', pattern: '**/package.json' }, new Fixer(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.workspace.onDidOpenTextDocument((d) => schedule(d, 0)),
    vscode.workspace.onDidSaveTextDocument((d) => schedule(d, 0)),
    // keep the state: the sidebar still shows this project. A scan still running for the closed document must not bring its diagnostics back.
    vscode.workspace.onDidCloseTextDocument((d) => {
      const key = d.uri.toString();
      clearTimeout(timers.get(key));
      timers.delete(key);
      cancelScans(key);
      diagnostics.delete(d.uri);
    }),
    // granting trust turns the audit fallback (and installs) on: results made without it are out of date
    vscode.workspace.onDidGrantWorkspaceTrust(() => refreshAll(false)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('pkgGuard.refreshIntervalHours')) schedulePeriodic();
      if (e.affectsConfiguration('pkgGuard')) refreshAll(false);
    }),
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

  const watcher = vscode.workspace.createFileSystemWatcher('**/{yarn.lock,package-lock.json,pnpm-lock.yaml,bun.lock,package.json}');
  let watchTimer: NodeJS.Timeout | undefined;
  const onFile = (u: vscode.Uri) => {
    if (/[\\/]node_modules[\\/]/.test(u.fsPath)) return;
    // a package.json saved from an open editor is already being scanned by the save handler
    const key = u.toString();
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    if (doc && /package\.json$/.test(u.fsPath) && (running.has(key) || timers.has(key) || states.get(key)?.version === doc.version)) return;
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
  timers.clear();
}
