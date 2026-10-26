import * as path from 'path';
import * as vscode from 'vscode';
import { CompatReport, Dependent, checkCompat, findCompanion, formatReport } from './compat';
import { install, offerInstall, runInTerminal } from './install';
import { Section, addToSection, locateDeps } from './packageJson';
import { addSorted, removeDependency } from './pkgEdit';
import { detectPm } from './pm';
import { RegistryInfo, fetchInfo } from './registry';
import { changelogBetween, fetchMeta, npmUrl } from './repo';
import { satisfies } from './satisfies';
import { readInstalledPkg } from './scan';
import { baseVersion, compare, diffKind, gt, isStable, prefixOf } from './semver';
import { readText, scanUri, settings, states } from './store';
import { ActionNode, DepNode, ProjectNode, ScriptNode, VersionNode } from './tree';
import { BumpKind, bumpTargets, newerVersions, previousVersion } from './bump';

type WithUri = { uri: vscode.Uri };

async function openDoc(uri: vscode.Uri): Promise<vscode.TextDocument> {
  return vscode.workspace.openTextDocument(uri);
}

function pmFor(uri: vscode.Uri) {
  let pkg: any;
  try {
    pkg = JSON.parse(readText(uri).text);
  } catch {
    /* keep going without the packageManager field */
  }
  return detectPm(path.dirname(uri.fsPath), pkg);
}

async function showMarkdown(md: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
}

interface RangeUpdate {
  name: string;
  version: string;
  section?: Section;
}

/** Rewrites dependency ranges in package.json (keeps ^ / ~ style). Returns the document, or undefined if nothing matched. */
async function setRanges(uri: vscode.Uri, updates: RangeUpdate[]): Promise<vscode.TextDocument | undefined> {
  const doc = await openDoc(uri);
  const entries = locateDeps(doc.getText());
  const we = new vscode.WorkspaceEdit();
  let n = 0;
  for (const u of updates) {
    const matches = entries.filter((e) => e.name === u.name && (!u.section || e.section === u.section));
    for (const e of matches.slice(0, u.section ? 1 : matches.length)) {
      const prefix = baseVersion(e.range) ? prefixOf(e.range) : '^';
      we.replace(uri, new vscode.Range(e.line, e.versionStart, e.line, e.versionEnd), prefix + u.version);
      n++;
    }
  }
  if (!n) return undefined;
  await vscode.workspace.applyEdit(we);
  return doc;
}

async function replaceWhole(uri: vscode.Uri, text: string): Promise<vscode.TextDocument> {
  const doc = await openDoc(uri);
  const we = new vscode.WorkspaceEdit();
  we.replace(uri, doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0)), text);
  await vscode.workspace.applyEdit(we);
  return doc;
}

/** What else changes if `name` goes from its installed version to `target`. */
async function compatFor(node: DepNode, info: RegistryInfo, target: string): Promise<CompatReport> {
  const dir = path.dirname(node.uri.fsPath);
  const st = states.get(node.uri.toString());
  const installed = st?.result.installed.get(node.name);
  const pkg = JSON.parse(readText(node.uri).text);
  const direct = locateDeps(readText(node.uri).text);
  const installedOf = (d: string): string | undefined => st?.result.installed.get(d) ?? readInstalledPkg(dir, d)?.version;

  // installed packages that peer on this one: read their manifests from node_modules, ask the registry only for the ones that would break
  const dependents: Dependent[] = [];
  for (const e of direct) {
    if (e.name === node.name) continue;
    const m = readInstalledPkg(dir, e.name);
    const range: string | undefined = m?.peerDependencies?.[node.name];
    if (!m || range === undefined) continue;
    const dep: Dependent = { name: e.name, version: m.version, peerRange: range, optional: !!m.peerDependenciesMeta?.[node.name]?.optional };
    if (!satisfies(target, range)) {
      const depInfo = await fetchInfo(e.name, settings().registry);
      if (depInfo) dep.fixedBy = findCompanion(depInfo.versions, depInfo.manifests, node.name, target, m.version);
    }
    dependents.push(dep);
  }
  return checkCompat({
    name: node.name,
    installed,
    target,
    current: installed ? info.manifests[installed] : undefined,
    next: info.manifests[target],
    installedOf,
    projectNode: pkg.engines?.node,
    dependents,
  });
}

function latestStable(info: RegistryInfo): string | undefined {
  let best = info.latest && isStable(info.latest) ? info.latest : undefined;
  for (const v of info.versions) if (isStable(v) && (!best || gt(v, best))) best = v;
  return best;
}

async function pickVersion(node: DepNode, info: RegistryInfo, installed?: string): Promise<string | undefined> {
  const latest = latestStable(info);
  const stable = info.versions.filter(isStable).sort((a, b) => compare(b, a)).slice(0, 80);
  const items = stable.map((v) => {
    const kind = installed ? diffKind(installed, v) : null;
    const tags = [v === latest ? 'latest' : '', v === installed ? 'installed' : '', info.deprecated[v] ? 'deprecated' : '', kind && kind !== 'patch' ? kind : kind ?? ''].filter(Boolean);
    return { label: v, description: tags.join(' · '), v };
  });
  const pick = await vscode.window.showQuickPick(items, { placeHolder: `Version of ${node.name} (installed ${installed ?? '?'})`, matchOnDescription: true });
  return pick?.v;
}

async function updateFlow(node: DepNode, target: string | undefined, onlyReport = false): Promise<void> {
  const st = states.get(node.uri.toString()) ?? (await scanUri(node.uri));
  const installed = st?.result.installed.get(node.name);
  const info = await fetchInfo(node.name, settings().registry);
  if (!info) return void vscode.window.showErrorMessage(`Could not read ${node.name} from the registry.`);
  const to = target ?? (await pickVersion(node, info, installed));
  if (!to) return;
  if (installed && compare(to, installed) === 0) return void vscode.window.showInformationMessage(`${node.name} is already at ${to}.`);

  const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking ${node.name}@${to} compatibility…` }, () => compatFor(node, info, to));
  const text = formatReport(node.name, installed, to, report);
  if (onlyReport) return showMarkdown('```text\n' + text + '\n```');

  const problems = report.issues.some((i) => i.level === 'error' || i.level === 'warn');
  const updates: RangeUpdate[] = [{ name: node.name, version: to, section: node.section }];
  if (problems) {
    const hasErr = report.issues.some((i) => i.level === 'error');
    const buttons = [hasErr ? 'Update anyway' : 'Update'];
    const withCompanions = report.companions.length ? `Update + ${report.companions.length} companion${report.companions.length > 1 ? 's' : ''}` : undefined;
    if (withCompanions) buttons.unshift(withCompanions);
    buttons.push('View report');
    const pick = await vscode.window.showWarningMessage(`${node.name} ${installed ?? '?'} → ${to}`, { modal: true, detail: text }, ...buttons);
    if (!pick) return;
    if (pick === 'View report') return showMarkdown('```text\n' + text + '\n```');
    if (pick === withCompanions) for (const c of report.companions) updates.push({ name: c.name, version: c.to });
  }
  const doc = await setRanges(node.uri, updates);
  if (doc) await offerInstall(doc, pmFor(node.uri));
}

async function openRepo(node: DepNode): Promise<void> {
  const meta = await fetchMeta(node.name, settings().registry);
  const url = meta?.repo ? (meta.repo.directory && meta.repo.host === 'github' ? `${meta.repo.url}/tree/HEAD/${meta.repo.directory}` : meta.repo.url) : meta?.homepage;
  if (!url) return void vscode.window.showWarningMessage(`${node.name} does not declare a repository.`);
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

/** Release notes for versions in (from, to] of one package, shown as a Markdown preview. */
async function showNotes(name: string, from: string, to: string, title: string): Promise<void> {
  const meta = await fetchMeta(name, settings().registry);
  if (!meta?.repo) return void vscode.env.openExternal(vscode.Uri.parse(npmUrl(name)));
  const repo = meta.repo;
  const releases = repo.host === 'github' ? `${repo.url}/releases` : repo.url;
  const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Fetching ${name} release notes…` }, () => changelogBetween(name, repo, from, to));
  if (!res) {
    const open = 'Open releases page';
    const pick = await vscode.window.showInformationMessage(`No release notes found for ${title}.`, open);
    if (pick) await vscode.env.openExternal(vscode.Uri.parse(releases));
    return;
  }
  await showMarkdown(`# ${title}\n\n_Source: ${res.source}_\n\n${res.markdown}`);
}

/** Pick one newer version (or "everything up to latest") and read its notes. */
async function changelog(node: DepNode): Promise<void> {
  const st = states.get(node.uri.toString()) ?? (await scanUri(node.uri));
  const installed = st?.result.installed.get(node.name);
  const info = await fetchInfo(node.name, settings().registry);
  const versions = info ? newerVersions(installed, info.versions) : [];
  if (!info || !installed || !versions.length) {
    const meta = await fetchMeta(node.name, settings().registry);
    const url = meta?.repo ? (meta.repo.host === 'github' ? `${meta.repo.url}/releases` : meta.repo.url) : npmUrl(node.name);
    return void vscode.env.openExternal(vscode.Uri.parse(url));
  }
  const latest = versions[0];
  type Item = vscode.QuickPickItem & { from?: string; to?: string };
  const items: Item[] = [
    { label: `$(list-flat) Everything since ${installed}`, description: `up to ${latest}`, from: installed, to: latest },
    { label: 'Single versions', kind: vscode.QuickPickItemKind.Separator },
    ...versions.slice(0, 60).map((v): Item => {
      const kind = diffKind(installed, v);
      return { label: v, description: [v === latest ? 'latest' : '', kind ?? ''].filter(Boolean).join(' · '), from: previousVersion(v, info.versions) ?? installed, to: v };
    }),
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: `Changelog of ${node.name} (installed ${installed})`, matchOnDescription: true });
  if (!pick?.from || !pick.to) return;
  const single = pick.from !== installed || pick.to !== latest;
  await showNotes(node.name, pick.from, pick.to, single && pick.to !== latest ? `${node.name} ${pick.to}` : `${node.name} ${installed} → ${pick.to}`);
}

function asDep(n: VersionNode): DepNode {
  return { kind: 'dep', uri: n.uri, name: n.name, range: '', section: n.section };
}

/** Newest patch / minor / major of a dependency, then the usual compatibility check + update. */
async function updateBump(node: DepNode, kind: BumpKind): Promise<void> {
  const st = states.get(node.uri.toString()) ?? (await scanUri(node.uri));
  const installed = st?.result.installed.get(node.name);
  const info = await fetchInfo(node.name, settings().registry);
  const target = installed && info ? bumpTargets(installed, info.versions)[kind] : undefined;
  if (!target) return void vscode.window.showInformationMessage(`No ${kind} update available for ${node.name}.`);
  await updateFlow(node, target);
}

/** Bulk update every dependency to its newest patch / minor / major. */
async function updateAll(uri: vscode.Uri, level: BumpKind): Promise<void> {
  const st = states.get(uri.toString()) ?? (await scanUri(uri));
  if (!st) return;
  const updates: RangeUpdate[] = [];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const e of locateDeps(readText(uri).text)) {
    const installed = st.result.installed.get(e.name);
    const info = st.result.info.get(e.name);
    if (seen.has(e.name) || !installed || !info) continue;
    seen.add(e.name);
    const t = bumpTargets(installed, info.versions);
    const pick = level === 'patch' ? t.patch : level === 'minor' ? (t.minor ?? t.patch) : (t.major ?? t.minor ?? t.patch);
    if (!pick) continue;
    updates.push({ name: e.name, version: pick, section: e.section });
    lines.push(`• ${e.name}  ${installed} → ${pick}  (${diffKind(installed, pick)})`);
  }
  if (!updates.length) return void vscode.window.showInformationMessage(`No ${level} updates available.`);
  const warn = level === 'major' ? '\n\nMajor updates can contain breaking changes. Check single packages first with "Check compatibility".' : '';
  const ok = `Update ${updates.length}`;
  const pick = await vscode.window.showWarningMessage(`Update ${updates.length} dependencies (${level})?`, { modal: true, detail: lines.join('\n') + warn }, ok);
  if (pick !== ok) return;
  const doc = await setRanges(uri, updates);
  if (doc) await offerInstall(doc, pmFor(uri));
}

/** Applies every vulnerability fix: direct dependencies are bumped, transitive ones are pinned via resolutions / overrides. */
async function fixVulns(uri: vscode.Uri): Promise<void> {
  const st = states.get(uri.toString()) ?? (await scanUri(uri));
  if (!st) return;
  const updates = new Map<string, RangeUpdate>();
  const pins = new Map<string, { section: string; name: string; range: string }>();
  for (const f of st.findings) {
    for (const fx of f.fixes) {
      if (fx.type === 'setVersion' && f.kind === 'vuln') updates.set(f.entry.name, { name: f.entry.name, version: fx.range.replace(/^[\^~]/, ''), section: f.entry.section });
      if (fx.type === 'addOverride' && f.kind === 'transitive') pins.set(fx.name, fx);
    }
  }
  if (!updates.size && !pins.size) return void vscode.window.showInformationMessage('No fixable vulnerabilities found.');
  const lines = [
    ...[...updates.values()].map((u) => `• update ${u.name} → ${u.version}`),
    ...[...pins.values()].map((p) => `• pin ${p.name} ${p.range} (${p.section})`),
  ];
  const ok = 'Fix';
  const pick = await vscode.window.showWarningMessage(`Fix ${lines.length} vulnerable packages?`, { modal: true, detail: lines.join('\n') }, ok);
  if (pick !== ok) return;
  let doc = updates.size ? await setRanges(uri, [...updates.values()]) : await openDoc(uri);
  if (doc && pins.size) {
    let text = doc.getText();
    for (const p of pins.values()) text = addToSection(text, p.section, p.name, p.range);
    doc = await replaceWhole(uri, text);
  }
  if (doc) await offerInstall(doc, pmFor(uri));
}

async function addDependency(uri: vscode.Uri): Promise<void> {
  const name = (await vscode.window.showInputBox({ prompt: 'Package to add', placeHolder: 'e.g. zod', validateInput: (v) => (v.trim() ? undefined : 'Enter a package name') }))?.trim();
  if (!name) return;
  const info = await fetchInfo(name, settings().registry);
  const latest = info && latestStable(info);
  if (!latest) return void vscode.window.showErrorMessage(`Package "${name}" was not found in the registry.`);
  const section = await vscode.window.showQuickPick(['dependencies', 'devDependencies'], { placeHolder: `Add ${name}@^${latest} to…` });
  if (!section) return;
  const doc = await replaceWhole(uri, addSorted(readText(uri).text, section, name, `^${latest}`));
  await offerInstall(doc, pmFor(uri));
}

async function remove(node: DepNode): Promise<void> {
  const ok = 'Remove';
  const pick = await vscode.window.showWarningMessage(`Remove ${node.name} from package.json?`, { modal: true }, ok);
  if (pick !== ok) return;
  const doc = await replaceWhole(node.uri, removeDependency(readText(node.uri).text, node.name));
  await offerInstall(doc, pmFor(node.uri));
}

async function reveal(uri: vscode.Uri, line: number): Promise<void> {
  const doc = await openDoc(uri);
  const ed = await vscode.window.showTextDocument(doc);
  const pos = new vscode.Position(line, 0);
  ed.selection = new vscode.Selection(pos, pos);
  ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

export function registerCommands(ctx: vscode.ExtensionContext, refresh: () => void): void {
  const reg = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const uriOf = (n: WithUri | vscode.Uri) => (n instanceof vscode.Uri ? n : n.uri);

  reg('pkgGuard.refreshTree', refresh);
  reg('pkgGuard.rescanProject', (n: WithUri) => scanUri(uriOf(n)));
  reg('pkgGuard.openPackageJson', async (n: WithUri) => void (await vscode.window.showTextDocument(await openDoc(uriOf(n)))));
  reg('pkgGuard.installAll', async (n: WithUri | ProjectNode | ActionNode) => install(await openDoc(uriOf(n)), pmFor(uriOf(n))));
  reg('pkgGuard.fixVulns', (n: WithUri) => fixVulns(uriOf(n)));
  reg('pkgGuard.updateAllPatch', (n: WithUri) => updateAll(uriOf(n), 'patch'));
  reg('pkgGuard.updateAllMinor', (n: WithUri) => updateAll(uriOf(n), 'minor'));
  reg('pkgGuard.updateAllMajor', (n: WithUri) => updateAll(uriOf(n), 'major'));
  reg('pkgGuard.addDependency', (n: WithUri) => addDependency(uriOf(n)));

  reg('pkgGuard.runScript', (n: ScriptNode) => {
    const pm = pmFor(n.uri);
    runInTerminal(`${n.name} · ${path.basename(path.dirname(n.uri.fsPath))}`, path.dirname(n.uri.fsPath), `${pm.name} run ${n.name}`);
  });
  reg('pkgGuard.revealScript', (n: ScriptNode) => reveal(n.uri, n.line));
  reg('pkgGuard.revealDep', async (n: DepNode) => {
    const e = locateDeps(readText(n.uri).text).find((x) => x.name === n.name && x.section === n.section);
    if (e) await reveal(n.uri, e.line);
  });

  reg('pkgGuard.openNpm', (n: DepNode) => vscode.env.openExternal(vscode.Uri.parse(npmUrl(n.name))));
  reg('pkgGuard.openRepo', openRepo);
  reg('pkgGuard.changelog', changelog);
  reg('pkgGuard.updateLatest', async (n: DepNode) => {
    const info = await fetchInfo(n.name, settings().registry);
    const latest = info && latestStable(info);
    if (!latest) return void vscode.window.showErrorMessage(`Could not read ${n.name} from the registry.`);
    await updateFlow(n, latest);
  });
  reg('pkgGuard.updatePatch', (n: DepNode) => updateBump(n, 'patch'));
  reg('pkgGuard.updateMinor', (n: DepNode) => updateBump(n, 'minor'));
  reg('pkgGuard.updateMajor', (n: DepNode) => updateBump(n, 'major'));
  reg('pkgGuard.updateVersion', (n: VersionNode) => updateFlow(asDep(n), n.version));
  reg('pkgGuard.versionChangelog', (n: VersionNode) => showNotes(n.name, n.installed, n.version, `${n.name} ${n.installed} → ${n.version}`));
  reg('pkgGuard.versionChangelogOnly', (n: VersionNode) => showNotes(n.name, previousVersion(n.version, states.get(n.uri.toString())?.result.info.get(n.name)?.versions ?? []) ?? n.installed, n.version, `${n.name} ${n.version}`));
  reg('pkgGuard.updateTo', (n: DepNode) => updateFlow(n, undefined));
  reg('pkgGuard.checkCompat', (n: DepNode) => updateFlow(n, undefined, true));
  reg('pkgGuard.remove', remove);
  reg('pkgGuard.copyName', (n: DepNode) => vscode.env.clipboard.writeText(n.name));

}
