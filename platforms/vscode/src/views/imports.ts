import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { importFindings } from '@core/imports/findings';
import { createManifestLookup } from '@core/imports/manifestLookup';
import { ImportFinding, ManifestFindings } from '@core/types';
import { onDidChange, scanUri, states } from '../services/store';

const LANGUAGES = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'vue', 'svelte', 'astro']);
const RANK = { error: 3, warning: 2, info: 1 } as const;
const COLOR = { error: 'editorError.foreground', warning: 'editorWarning.foreground', info: 'editorCodeLens.foreground' } as const;

function isSource(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === 'file' && LANGUAGES.has(doc.languageId) && !/[\\/]node_modules[\\/]/.test(doc.fileName);
}

function enabled(): boolean {
  return vscode.workspace.getConfiguration('pkgGuard').get('importWarnings', true);
}

const lookup = createManifestLookup(fs.existsSync);

/** The package.jsons above a source file, nearest first, up to its workspace folder. Scans the ones not scanned yet. */
async function manifestsFor(doc: vscode.TextDocument): Promise<ManifestFindings[]> {
  const top = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath;
  const out: ManifestFindings[] = [];
  for (const file of lookup.above(path.dirname(doc.uri.fsPath), top)) {
    const uri = vscode.Uri.file(file);
    const st = states.get(uri.toString()) ?? (await scanUri(uri));
    if (st) out.push({ entries: st.result.entries, findings: st.findings });
  }
  return out;
}

/** Import warnings: the vulnerability Findings of a dependency, repeated on the imports of that package in JS/TS files. */
export function registerImportWarnings(ctx: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection('pkg-guard-imports');
  const decos = {
    error: vscode.window.createTextEditorDecorationType({}),
    warning: vscode.window.createTextEditorDecorationType({}),
    info: vscode.window.createTextEditorDecorationType({}),
  };
  const results = new Map<string, { version: number; findings: ImportFinding[] }>();
  const tickets = new Map<string, number>();
  const timers = new Map<string, NodeJS.Timeout>();

  const decorate = (ed: vscode.TextEditor) => {
    const r = results.get(ed.document.uri.toString());
    const buckets: Record<ImportFinding['level'], vscode.DecorationOptions[]> = { error: [], warning: [], info: [] };
    if (r && r.version === ed.document.version) {
      const byLine = new Map<number, ImportFinding[]>();
      for (const f of r.findings) byLine.set(f.ref.line, [...(byLine.get(f.ref.line) ?? []), f]);
      for (const [line, fs] of byLine) {
        fs.sort((a, b) => RANK[b.level] - RANK[a.level]);
        const worst = fs[0].level;
        const end = ed.document.lineAt(line).text.length;
        buckets[worst].push({
          range: new vscode.Range(line, end, line, end),
          hoverMessage: new vscode.MarkdownString().appendText(fs.map((f) => f.message).join('\n\n')),
          renderOptions: { after: { contentText: `   ${fs.map((f) => f.inline).join('  ')}`, fontStyle: 'italic', color: new vscode.ThemeColor(COLOR[worst]) } },
        });
      }
    }
    ed.setDecorations(decos.error, buckets.error);
    ed.setDecorations(decos.warning, buckets.warning);
    ed.setDecorations(decos.info, buckets.info);
  };

  const clear = (doc: vscode.TextDocument) => {
    const key = doc.uri.toString();
    results.delete(key);
    tickets.delete(key); // a run still in flight sees its ticket gone and drops its result
    clearTimeout(timers.get(key));
    timers.delete(key);
    diagnostics.delete(doc.uri);
    for (const ed of vscode.window.visibleTextEditors) if (ed.document === doc) decorate(ed);
  };

  const run = async (doc: vscode.TextDocument) => {
    if (!isSource(doc) || doc.isClosed) return;
    if (!enabled()) return clear(doc);
    const key = doc.uri.toString();
    const ticket = (tickets.get(key) ?? 0) + 1;
    tickets.set(key, ticket);
    const version = doc.version;
    const findings = importFindings(doc.getText(), await manifestsFor(doc));
    if (tickets.get(key) !== ticket || doc.isClosed) return; // superseded by a newer run
    results.set(key, { version, findings });
    diagnostics.set(
      doc.uri,
      findings.map((f) => {
        const d = new vscode.Diagnostic(new vscode.Range(f.ref.line, f.ref.start, f.ref.line, f.ref.end), f.message, f.level === 'error' ? vscode.DiagnosticSeverity.Error : f.level === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information);
        d.source = 'pkg-guard';
        if (f.code && f.url) d.code = { value: f.code, target: vscode.Uri.parse(f.url) };
        return d;
      }),
    );
    for (const ed of vscode.window.visibleTextEditors) if (ed.document === doc) decorate(ed);
  };

  const schedule = (doc: vscode.TextDocument, delay = 300) => {
    if (!isSource(doc)) return;
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void run(doc);
      }, delay),
    );
  };
  const scheduleAll = () => vscode.workspace.textDocuments.forEach((d) => schedule(d));

  // a package.json created, deleted or moved changes which manifest is nearest
  const manifests = vscode.workspace.createFileSystemWatcher('**/package.json', false, true, false);
  manifests.onDidCreate(() => lookup.invalidate());
  manifests.onDidDelete(() => lookup.invalidate());
  // folder deletes and moves arrive as one event that the glob above may not match
  const folderChanged = () => lookup.invalidate();

  ctx.subscriptions.push(
    manifests,
    vscode.workspace.onDidDeleteFiles(folderChanged),
    vscode.workspace.onDidRenameFiles(folderChanged),
    vscode.workspace.onDidChangeWorkspaceFolders(folderChanged),
    diagnostics,
    decos.error,
    decos.warning,
    decos.info,
    { dispose: () => timers.forEach((t) => clearTimeout(t)) },
    // a package.json scan finished; debounced since a refresh scans every project
    onDidChange.event(scheduleAll),
    vscode.workspace.onDidOpenTextDocument((d) => schedule(d, 0)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!isSource(e.document)) return;
      for (const ed of vscode.window.visibleTextEditors) if (ed.document === e.document) decorate(ed); // hide stale text right away
      schedule(e.document);
    }),
    vscode.workspace.onDidCloseTextDocument(clear),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('pkgGuard.importWarnings') && scheduleAll()),
    vscode.window.onDidChangeVisibleTextEditors((eds) => eds.forEach(decorate)),
  );
  vscode.workspace.textDocuments.forEach((d) => schedule(d, 0));
}
