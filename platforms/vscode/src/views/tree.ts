import * as path from 'path';
import * as vscode from 'vscode';
import { BumpKind, BumpTargets, bumpTargets } from '@core/updates/bump';
import { Finding } from '@core/scan/findings';
import { compare } from '@core/utils/semver';
import { Section, locateDeps } from '@core/manifest/packageJson';
import { locateKeys } from '@core/manifest/pkgEdit';
import { baseVersion } from '@core/utils/semver';
import { findProjects, onDidChange, readText, scanUri, states } from '../services/store';

export interface ProjectNode { kind: 'project'; uri: vscode.Uri; name: string; duplicate: boolean }
export interface GroupNode { kind: 'group'; id: 'scripts' | 'attention' | 'deps' | 'actions'; uri: vscode.Uri; label: string; section?: Section; count: number }
export interface ScriptNode { kind: 'script'; uri: vscode.Uri; name: string; command: string; line: number }
export interface DepNode { kind: 'dep'; uri: vscode.Uri; name: string; range: string; section: Section }
export interface ActionNode { kind: 'action'; uri: vscode.Uri; label: string; icon: string; command: string; description?: string }
export interface MessageNode { kind: 'message'; label: string }
/** One available update of a dependency: the newest patch, minor or major version. */
export interface VersionNode { kind: 'version'; uri: vscode.Uri; name: string; section: Section; version: string; bump: BumpKind; installed: string; fixesVuln: boolean }
export type Node = ProjectNode | GroupNode | ScriptNode | DepNode | VersionNode | ActionNode | MessageNode;

const BUMP_LABEL: Record<BumpKind, string> = { patch: 'Patch', minor: 'Minor', major: 'Major' };
const BUMP_COLOR: Record<BumpKind, string> = { patch: 'charts.green', minor: 'charts.blue', major: 'charts.orange' };

function updatesFor(uri: vscode.Uri, name: string): { installed?: string; targets: BumpTargets } {
  const st = states.get(uri.toString());
  const installed = st?.result.installed.get(name);
  const info = st?.result.info.get(name);
  return { installed, targets: installed && info ? bumpTargets(installed, info.versions) : {} };
}

const SECTION_LABEL: Record<Section, string> = {
  dependencies: 'dependencies',
  devDependencies: 'devDependencies',
  optionalDependencies: 'optionalDependencies',
};

function level(fs: Finding[]): 'error' | 'warning' | 'info' | null {
  if (fs.some((f) => f.severity === 'error')) return 'error';
  if (fs.some((f) => f.severity === 'warning')) return 'warning';
  return fs.length ? 'info' : null;
}

export class PackagesTree implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private timer: NodeJS.Timeout | undefined;

  constructor() {
    // scans finish asynchronously; coalesce the resulting change events
    onDidChange.event(() => this.refresh());
  }

  refresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emitter.fire(undefined), 150);
  }

  private load(uri: vscode.Uri): any | null {
    try {
      return JSON.parse(readText(uri).text);
    } catch {
      return null;
    }
  }

  async getChildren(el?: Node): Promise<Node[]> {
    if (!el) {
      const files = await findProjects();
      if (!files.length) return [{ kind: 'message', label: 'No package.json found in this workspace' }];
      const projects = files.map((uri) => {
        if (!states.has(uri.toString())) void scanUri(uri);
        return { kind: 'project', uri, name: this.load(uri)?.name ?? path.basename(path.dirname(uri.fsPath)), duplicate: false } as ProjectNode;
      });
      // the folder is only worth showing when the name alone is ambiguous
      const count = new Map<string, number>();
      for (const p of projects) count.set(p.name, (count.get(p.name) ?? 0) + 1);
      for (const p of projects) p.duplicate = (count.get(p.name) ?? 0) > 1;
      return projects;
    }
    if (el.kind === 'project') return this.projectChildren(el);
    if (el.kind === 'group') return this.groupChildren(el);
    if (el.kind === 'dep') return this.versionChildren(el);
    return [];
  }

  private versionChildren(d: DepNode): Node[] {
    const { installed, targets } = updatesFor(d.uri, d.name);
    if (!installed) return [];
    // a version fixes the vulnerabilities when it reaches the highest fixed-in version of the direct advisories
    const fixTarget = states.get(d.uri.toString())?.findings.find((f) => f.kind === 'vuln' && f.entry.name === d.name)?.fixes.find((x) => x.type === 'setVersion');
    const need = fixTarget && fixTarget.type === 'setVersion' ? fixTarget.range.replace(/^[\^~]/, '') : undefined;
    return (['patch', 'minor', 'major'] as BumpKind[])
      .filter((k) => targets[k])
      .map((k) => ({ kind: 'version', uri: d.uri, name: d.name, section: d.section, version: targets[k]!, bump: k, installed, fixesVuln: !!need && compare(targets[k]!, need) >= 0 }) as VersionNode);
  }

  private projectChildren(p: ProjectNode): Node[] {
    const pkg = this.load(p.uri);
    if (!pkg) return [{ kind: 'message', label: 'package.json is not valid JSON' }];
    const { text } = readText(p.uri);
    const st = states.get(p.uri.toString());
    const out: Node[] = [];
    const scripts = Object.keys(pkg.scripts ?? {}).length;
    if (scripts) out.push({ kind: 'group', id: 'scripts', uri: p.uri, label: 'Scripts', count: scripts });
    const attention = st ? new Set(st.findings.map((f) => f.entry.name)).size : 0;
    if (attention) out.push({ kind: 'group', id: 'attention', uri: p.uri, label: 'Needs attention', count: attention });
    const entries = locateDeps(text);
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'] as Section[]) {
      const n = entries.filter((e) => e.section === section).length;
      if (n) out.push({ kind: 'group', id: 'deps', uri: p.uri, label: SECTION_LABEL[section], section, count: n });
    }
    out.push({ kind: 'group', id: 'actions', uri: p.uri, label: 'Actions', count: 0 });
    return out;
  }

  private groupChildren(g: GroupNode): Node[] {
    const { text } = readText(g.uri);
    const pkg = this.load(g.uri);
    if (!pkg) return [];
    if (g.id === 'scripts') {
      const lines = new Map(locateKeys(text, 'scripts').map((k) => [k.key, k.line]));
      return Object.entries<string>(pkg.scripts ?? {}).map(([name, command]) => ({ kind: 'script', uri: g.uri, name, command, line: lines.get(name) ?? 0 }));
    }
    if (g.id === 'actions') {
      const a = (label: string, icon: string, command: string, description?: string): ActionNode => ({ kind: 'action', uri: g.uri, label, icon, command, description });
      return [
        a('Install all dependencies', 'cloud-download', 'pkgGuard.installAll'),
        a('Fix vulnerabilities', 'shield', 'pkgGuard.fixVulns', 'update vulnerable dependencies'),
        a('Update all — patch', 'chevron-up', 'pkgGuard.updateAllPatch', 'x.y.Z'),
        a('Update all — minor', 'fold-up', 'pkgGuard.updateAllMinor', 'x.Y.z, includes patch'),
        a('Update all — major', 'rocket', 'pkgGuard.updateAllMajor', 'X.y.z, may break'),
        a('Add dependency…', 'add', 'pkgGuard.addDependency'),
        a('Re-scan vulnerabilities & updates', 'refresh', 'pkgGuard.rescanProject'),
        a('Open package.json', 'go-to-file', 'pkgGuard.openPackageJson'),
      ];
    }
    const entries = locateDeps(text);
    if (g.id === 'attention') {
      const st = states.get(g.uri.toString());
      const bad = new Set(st?.findings.map((f) => `${f.entry.section}:${f.entry.name}`));
      return entries.filter((e) => bad.has(`${e.section}:${e.name}`)).map((e) => ({ kind: 'dep', uri: g.uri, name: e.name, range: e.range, section: e.section }));
    }
    return entries.filter((e) => e.section === g.section).map((e) => ({ kind: 'dep', uri: g.uri, name: e.name, range: e.range, section: e.section }));
  }

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.kind) {
      case 'message':
        return new vscode.TreeItem(n.label);
      case 'project': {
        const it = new vscode.TreeItem(n.name, vscode.TreeItemCollapsibleState.Expanded);
        it.iconPath = new vscode.ThemeIcon('folder-library');
        it.id = n.uri.toString();
        it.contextValue = 'project';
        if (n.duplicate) it.description = vscode.workspace.asRelativePath(path.dirname(n.uri.fsPath), true);
        const st = states.get(n.uri.toString());
        const info = !st ? 'scanning…' : `${st.result.pm.name}${st.result.source === 'audit' ? ' · audit fallback' : ''}`;
        it.tooltip = `${n.uri.fsPath}\n${info}`;
        return it;
      }
      case 'group': {
        const open = n.id === 'actions' || n.id === 'attention' || n.id === 'scripts' || n.section === 'dependencies';
        const it = new vscode.TreeItem(n.label, open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        it.iconPath = new vscode.ThemeIcon(n.id === 'scripts' ? 'terminal' : n.id === 'actions' ? 'tools' : n.id === 'attention' ? 'warning' : 'package');
        if (n.count) it.description = String(n.count);
        it.id = `${n.uri.toString()}|${n.id}|${n.section ?? ''}`;
        it.contextValue = `group.${n.id}`;
        return it;
      }
      case 'action': {
        const it = new vscode.TreeItem(n.label);
        it.iconPath = new vscode.ThemeIcon(n.icon);
        it.description = n.description;
        it.command = { command: n.command, title: n.label, arguments: [n] };
        return it;
      }
      case 'script': {
        const it = new vscode.TreeItem(n.name);
        it.description = n.command;
        it.tooltip = `${n.name}: ${n.command}`;
        it.iconPath = new vscode.ThemeIcon(/^(test|e2e|spec)/.test(n.name) ? 'beaker' : /^(dev|start|serve|watch)/.test(n.name) ? 'debug-start' : /^build/.test(n.name) ? 'tools' : 'terminal');
        it.contextValue = 'script';
        it.command = { command: 'pkgGuard.revealScript', title: 'Go to script', arguments: [n] };
        return it;
      }
      case 'dep':
        return this.depItem(n);
      case 'version': {
        const it = new vscode.TreeItem(`${BUMP_LABEL[n.bump]}  →  ${n.version}`);
        it.id = `${n.uri.toString()}|${n.section}|${n.name}|${n.bump}`;
        it.description = n.fixesVuln ? `from ${n.installed}  · fixes vulnerabilities` : `from ${n.installed}`;
        it.iconPath = new vscode.ThemeIcon(n.bump === 'patch' ? 'chevron-up' : n.bump === 'minor' ? 'fold-up' : 'rocket', new vscode.ThemeColor(BUMP_COLOR[n.bump]));
        it.tooltip = `${BUMP_LABEL[n.bump]} update ${n.name} ${n.installed} → ${n.version}`;
        it.contextValue = `version.${n.bump}`;
        it.command = { command: 'pkgGuard.versionChangelog', title: 'Show changelog', arguments: [n] };
        return it;
      }
    }
  }

  private depItem(n: DepNode): vscode.TreeItem {
    const st = states.get(n.uri.toString());
    const mine = (st?.findings ?? []).filter((f) => f.entry.name === n.name && f.entry.section === n.section);
    const installed = st?.result.installed.get(n.name);
    const { targets } = updatesFor(n.uri, n.name);
    const has = (['patch', 'minor', 'major'] as BumpKind[]).filter((k) => targets[k]);
    const it = new vscode.TreeItem(n.name, has.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    it.id = `${n.uri.toString()}|${n.section}|${n.name}`;
    const shown = installed && installed !== baseVersion(n.range) ? `${n.range} (${installed})` : n.range;
    const hints = mine.map((f) => f.inline).join('  ');
    it.description = hints ? `${shown}   ${hints}` : shown;
    const lvl = level(mine);
    it.iconPath =
      lvl === 'error' ? new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'))
      : lvl === 'warning' ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'))
      : lvl === 'info' ? new vscode.ThemeIcon('arrow-circle-up', new vscode.ThemeColor('problemsInfoIcon.foreground'))
      : new vscode.ThemeIcon('package');
    const md = new vscode.MarkdownString(`**${n.name}** \`${n.range}\`${installed ? ` — installed \`${installed}\`` : ''}\n\n`);
    for (const f of mine) md.appendText(f.message + '\n\n');
    it.tooltip = md;
    const flags = (mine.some((f) => f.kind === 'vuln' || f.kind === 'transitive') ? '.vuln' : '') + (mine.some((f) => f.kind === 'outdated') ? '.update' : '');
    // flags drive which inline buttons appear: one per kind of update that actually exists
    it.contextValue = `dep${flags}${has.map((k) => `.${k}`).join('')}`;
    it.command = { command: 'pkgGuard.revealDep', title: 'Go to dependency', arguments: [n] };
    return it;
  }
}
