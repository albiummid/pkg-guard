#!/usr/bin/env node
// Repository CLI: versioning, changelog maintenance, and release workflow.
// Interactive tasks use Clack; subcommands remain available to CI.
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const p = require('@clack/prompts');

const root = path.resolve(__dirname, '..');
const versionFile = path.join(root, 'version.yml');
const changelogFile = path.join(root, 'CHANGELOG.md');
const sections = ['New Feature', 'Improvements', 'Fixes'];
const conventionalTypes = { feat: 'New Feature', fix: 'Fixes', perf: 'Improvements', refactor: 'Improvements', revert: 'Improvements' };

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function readVersionConfig() {
  const config = {};
  let section = '';
  for (const raw of fs.readFileSync(versionFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([\w.]+):\s*(.*?)\s*(?:#.*)?$/.exec(raw);
    if (!match) continue;
    const indent = raw.search(/\S/);
    if (indent === 0) {
      if (match[2]) { config[match[1]] = match[2]; section = ''; }
      else section = `${match[1]}.`;
    } else config[`${section}${match[1]}`] = match[2];
  }
  return config;
}

function bumpVersion(version, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`Cannot bump "${version}": expected x.y.z`);
  const [major, minor, patch] = match.slice(1).map(Number);
  return kind === 'major' ? `${major + 1}.0.0` : kind === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

function editVersionFiles(args) {
  let version = args[0];
  if (version === '--print') {
    console.log(readVersionConfig().version);
    return 0;
  }
  const check = version === '--check';
  if (version && !check) {
    const current = readVersionConfig().version;
    if (['patch', 'minor', 'major'].includes(version)) version = bumpVersion(current, version);
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) throw new Error(`Invalid version: ${version}`);
    fs.writeFileSync(versionFile, fs.readFileSync(versionFile, 'utf8').replace(/^version:.*$/m, `version: ${version}`));
  }

  const config = readVersionConfig();
  for (const key of ['version', 'vscode.engine', 'vscode.types', 'node.target', 'jetbrains.sinceBuild', 'jetbrains.ideaVersion', 'jetbrains.jvm']) {
    if (!config[key]) throw new Error(`version.yml is missing "${key}"`);
  }

  const editJson = (text, edit) => {
    const value = JSON.parse(text);
    edit(value);
    return `${JSON.stringify(value, null, 2)}\n`;
  };
  const targets = [
    ['package.json', (text) => editJson(text, (value) => {
      value.version = config.version;
      value.devDependencies['@types/vscode'] = config['vscode.types'];
    })],
    ['platforms/vscode/package.json', (text) => editJson(text, (value) => {
      value.version = config.version;
      value.engines.vscode = `^${config['vscode.engine']}`;
    })],
    ['platforms/jetbrains/gradle.properties', (text) => {
      const props = {
        version: config.version,
        'pkgguard.sinceBuild': config['jetbrains.sinceBuild'],
        'pkgguard.ideaVersion': config['jetbrains.ideaVersion'],
        'pkgguard.jvm': config['jetbrains.jvm'],
      };
      for (const [key, value] of Object.entries(props)) {
        const pattern = new RegExp(`^${key.replace(/\./g, '\\.')}=.*$`, 'm');
        text = pattern.test(text) ? text.replace(pattern, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
      }
      return text;
    }],
  ];

  let drift = false;
  for (const [relativePath, edit] of targets) {
    const file = path.join(root, relativePath);
    const before = fs.readFileSync(file, 'utf8');
    const after = edit(before).replace(/--target=node\d+/g, `--target=node${config['node.target']}`);
    if (before === after) continue;
    if (check) { drift = true; console.error(`out of sync: ${relativePath}`); }
    else fs.writeFileSync(file, after);
  }
  if (check) return drift ? 1 : 0;
  console.log(`version ${config.version} applied`);
  return 0;
}

const changelogHeader = `# Changelog

All notable changes to Pkg Guard are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/). Add entries under **Unreleased** as you go; \`yarn cli release\`
moves them under the new version. If Unreleased is empty at release time, entries are generated from the commit messages.
`;

function readChangelog() {
  return (fs.existsSync(changelogFile) ? fs.readFileSync(changelogFile, 'utf8') : `${changelogHeader}\n## [Unreleased]\n`).replace(/\r\n/g, '\n');
}

function parseChangelog(text) {
  const parts = text.split(/^## /m);
  const head = parts.shift();
  const parsedSections = parts.map((part) => {
    const newline = part.indexOf('\n');
    const title = part.slice(0, newline < 0 ? undefined : newline);
    const match = /^\[([^\]]+)\](?:\s+-\s+(\S+))?/.exec(title);
    const body = newline < 0 ? '' : part.slice(newline + 1);
    return { name: match ? match[1] : title, date: match?.[2], body: body.replace(/\n\[[^\]]+\]: \S+\s*$/gm, '').trim() };
  });
  return { head, sections: parsedSections };
}

function repositoryUrl() {
  try {
    return git('remote', 'get-url', 'origin').replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
  } catch { return ''; }
}

function renderChangelog({ head, sections: changelogSections }) {
  const output = [head.trimEnd(), ''];
  for (const section of changelogSections) {
    output.push(section.name === 'Unreleased' ? '## [Unreleased]' : `## [${section.name}] - ${section.date}`, '');
    if (section.body) output.push(section.body, '');
  }
  const url = repositoryUrl();
  if (/^https?:\/\//.test(url)) {
    const versions = changelogSections.filter((section) => section.name !== 'Unreleased').map((section) => section.name);
    const links = [];
    if (versions.length && changelogSections.some((section) => section.name === 'Unreleased')) links.push(`[Unreleased]: ${url}/compare/v${versions[0]}...HEAD`);
    versions.forEach((version, index) => links.push(`[${version}]: ${index + 1 < versions.length ? `${url}/compare/v${versions[index + 1]}...v${version}` : `${url}/releases/tag/v${version}`}`));
    output.push(...links, '');
  }
  return output.join('\n').replace(/\n{3,}/g, '\n\n');
}

function generatedNotes() {
  let range = [];
  try { range = [`${git('describe', '--tags', '--abbrev=0', '--match', 'v*')}..HEAD`]; } catch { /* no tags yet */ }
  const groups = new Map(sections.map((section) => [section, []]));
  for (const line of git('log', ...range, '--no-merges', '--pretty=format:%s').split('\n')) {
    const match = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/.exec(line.trim());
    if (!match || /^release v?\d/.test(match[4])) continue;
    const [, type, scope, breaking, subject] = match;
    const section = conventionalTypes[type];
    if (!section) continue;
    const title = subject.charAt(0).toUpperCase() + subject.slice(1);
    groups.get(section).push(`- ${breaking ? '**Breaking:** ' : ''}${scope ? `**${scope}:** ` : ''}${title}`);
  }
  return sections.filter((section) => groups.get(section).length)
    .map((section) => `### ${section}\n\n${groups.get(section).join('\n')}`).join('\n\n');
}

function changelogProblems(text) {
  const parsed = parseChangelog(text);
  const problems = [];
  if (!/^# Changelog\n/.test(text)) problems.push('must start with "# Changelog"');
  if (parsed.sections[0]?.name !== 'Unreleased') problems.push('first section must be "## [Unreleased]"');
  for (const section of parsed.sections.slice(1)) {
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(section.name) || !/^\d{4}-\d{2}-\d{2}$/.test(section.date ?? '')) problems.push(`bad heading for "${section.name}": use "## [x.y.z] - YYYY-MM-DD"`);
  }
  for (const section of parsed.sections) {
    for (const heading of section.body.match(/^### .*$/gm) ?? []) if (!sections.includes(heading.slice(4))) problems.push(`[${section.name}] unknown section "${heading}"; use ${sections.join(', ')}`);
  }
  return problems;
}

function manageChangelog(args) {
  const [command, version] = args;
  if (command === '--check') {
    const problems = changelogProblems(readChangelog());
    problems.forEach((problem) => console.error(`CHANGELOG.md: ${problem}`));
    return problems.length ? 1 : 0;
  }
  if (command === 'notes' && version) {
    const section = parseChangelog(readChangelog()).sections.find((item) => item.name === version);
    if (!section?.body) throw new Error(`CHANGELOG.md has no notes for ${version}.`);
    console.log(section.body);
    return 0;
  }
  if (command === 'add' && version) {
    const document = parseChangelog(readChangelog());
    if (document.sections.some((section) => section.name === version)) throw new Error(`CHANGELOG.md already has ${version}.`);
    const unreleased = document.sections.find((section) => section.name === 'Unreleased');
    const body = unreleased?.body || generatedNotes();
    if (!body) throw new Error('Nothing to release: Unreleased is empty and no feat/fix/perf/refactor commits were found.');
    const rest = document.sections.filter((section) => section.name !== 'Unreleased');
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(changelogFile, renderChangelog({ head: document.head, sections: [{ name: 'Unreleased', body: '' }, { name: version, date: today, body }, ...rest] }));
    console.log(`CHANGELOG.md: added ${version}`);
    return 0;
  }
  throw new Error('Usage: yarn cli changelog --check | notes <version> | add <version>');
}

function runStep(title, command, cwd = '.') {
  console.log(`\n> ${title}`);
  try { execSync(command, { cwd: path.join(root, cwd), stdio: 'inherit' }); }
  catch { throw new Error(`Failed: ${title}. Nothing was changed.`); }
}

function runCore(args) {
  const task = args[0];
  const core = root;
  const tsc = path.resolve(path.dirname(require.resolve('typescript')), '../bin/tsc');
  const run = (nodeArgs) => execFileSync(process.execPath, nodeArgs, { cwd: root, stdio: 'inherit' });

  if (task === 'compile' || task === 'test' || task === 'watch') {
    run([tsc, '-p', core, ...(task === 'watch' ? ['--watch'] : [])]);
    if (task !== 'test') return 0;
  }
  if (task === 'test') {
    const testDir = path.join(core, 'dist', 'test');
    const testFiles = fs.readdirSync(testDir).filter((name) => name.endsWith('.test.js')).map((name) => path.join(testDir, name));
    run(['--test', ...testFiles]);
    return 0;
  }
  if (task === 'build:server') {
    require('esbuild').buildSync({
      entryPoints: [path.join(core, 'src/server.ts')],
      bundle: true,
      platform: 'node',
      target: `node${readVersionConfig()['node.target']}`,
      outfile: path.join(core, 'dist/sidecar/server.js'),
    });
    return 0;
  }
  throw new Error('Usage: yarn cli core compile|watch|build:server|test');
}

function runVscode(args) {
  const task = args[0];
  if (!['typecheck', 'compile', 'package'].includes(task)) throw new Error('Usage: yarn cli vscode typecheck|compile|package');
  execSync(`yarn workspace pkg-guard ${task}`, { cwd: root, stdio: 'inherit' });
  return 0;
}

function prepareRelease(args) {
  const flags = new Set(args.filter((arg) => arg.startsWith('--')));
  const bump = args.find((arg) => !arg.startsWith('--'));
  if (flags.has('--help') || !bump) {
    console.log(`Usage: yarn cli release patch|minor|major|x.y.z [--push] [--skip-checks]

Requires a clean master up to date with origin, runs checks, bumps the version,
updates CHANGELOG.md, commits, and tags. --push also pushes master and the tag.`);
    return bump || flags.has('--help') ? 0 : 1;
  }

  if (git('status', '--porcelain')) throw new Error('Working tree is not clean. Commit or stash first.');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'master') throw new Error(`Release from master, not ${branch}.`);
  try {
    git('fetch', 'origin', 'master');
    const behind = Number(git('rev-list', '--count', 'HEAD..origin/master'));
    const ahead = Number(git('rev-list', '--count', 'origin/master..HEAD'));
    if (behind) throw new Error(`master is ${behind} commit(s) behind origin. Pull first.`);
    if (ahead && flags.has('--push')) console.log(`Note: ${ahead} unpushed commit(s) on master will be pushed with the release.`);
  } catch (error) {
    if (/behind origin/.test(error.message)) throw error;
    console.log('Could not reach origin; skipping the up-to-date check.');
  }

  if (!flags.has('--skip-checks')) {
    runStep('Core tests', 'node scripts/cli.js core test');
    runStep('VS Code typecheck', 'node scripts/cli.js vscode typecheck');
    runStep('Versions in sync', 'node scripts/cli.js version --check');
    runStep('Changelog format', 'node scripts/cli.js changelog --check');
  }

  editVersionFiles([bump]);
  const version = readVersionConfig().version;
  const tag = `v${version}`;
  if (git('tag', '--list', tag)) {
    execFileSync('git', ['checkout', '--', '.'], { cwd: root, stdio: 'inherit' });
    throw new Error(`Tag ${tag} already exists.`);
  }
  try { manageChangelog(['add', version]); }
  catch {
    execFileSync('git', ['checkout', '--', '.'], { cwd: root, stdio: 'inherit' });
    throw new Error('Release aborted and the version bump was reverted.');
  }

  git('add', '-A');
  git('commit', '-m', `chore: release ${tag}`);
  git('tag', '-a', tag, '-m', `Pkg Guard ${tag}`);
  console.log(`\nCommitted and tagged ${tag}.`);
  if (flags.has('--push')) {
    git('push', 'origin', 'master', tag);
    console.log(`Pushed ${tag}; the Release workflow is running (GitHub > Actions).`);
  } else console.log(`Push with: git push origin master ${tag}`);
  return 0;
}

async function interactive() {
  p.intro('Pkg Guard repository tasks');
  const task = await p.select({
    message: 'What would you like to do?',
    options: [
      { value: 'version', label: 'Sync or bump versions' },
      { value: 'changelog', label: 'Check changelog format' },
      { value: 'core', label: 'Build or test shared core' },
      { value: 'vscode', label: 'Check or package VS Code extension' },
      { value: 'release', label: 'Prepare a release' },
    ],
  });
  if (p.isCancel(task)) return p.cancel('Cancelled.');
  if (task === 'version') {
    const action = await p.select({ message: 'Choose a version action', options: [
      { value: 'sync', label: 'Sync from version.yml' }, { value: '--check', label: 'Check version sync' },
      { value: 'patch', label: 'Bump patch' }, { value: 'minor', label: 'Bump minor' }, { value: 'major', label: 'Bump major' },
    ] });
    if (p.isCancel(action)) return p.cancel('Cancelled.');
    return editVersionFiles(action === 'sync' ? [] : [action]);
  }
  if (task === 'changelog') return manageChangelog(['--check']);
  if (task === 'core') {
    const action = await p.select({ message: 'Choose a core task', options: [
      { value: 'test', label: 'Run core tests' }, { value: 'build:server', label: 'Build Node sidecar' },
      { value: 'compile', label: 'Compile TypeScript' }, { value: 'watch', label: 'Watch TypeScript' },
    ] });
    if (p.isCancel(action)) return p.cancel('Cancelled.');
    return runCore([action]);
  }
  if (task === 'vscode') {
    const action = await p.select({ message: 'Choose a VS Code task', options: [
      { value: 'typecheck', label: 'Typecheck extension' }, { value: 'package', label: 'Build VSIX package' },
    ] });
    if (p.isCancel(action)) return p.cancel('Cancelled.');
    return runVscode([action]);
  }
  const bump = await p.select({ message: 'Choose a release version bump', options: [
    { value: 'patch', label: 'Patch' }, { value: 'minor', label: 'Minor' }, { value: 'major', label: 'Major' },
  ] });
  if (p.isCancel(bump)) return p.cancel('Cancelled.');
  const push = await p.confirm({ message: 'Push the release tag after creating it? This starts the publishing workflow.', initialValue: false });
  if (p.isCancel(push)) return p.cancel('Cancelled.');
  return prepareRelease(push ? [bump, '--push'] : [bump]);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) { process.exitCode = await interactive(); return; }
  if (command === '--help' || command === '-h') {
    console.log('Usage: yarn cli [version|changelog|core|vscode|release] [arguments]\nRun without arguments to choose a task interactively.');
    return;
  }
  const status = command === 'version' ? editVersionFiles(args)
    : command === 'changelog' ? manageChangelog(args)
      : command === 'core' ? runCore(args)
        : command === 'vscode' ? runVscode(args)
      : command === 'release' ? prepareRelease(args) : undefined;
  if (status === undefined) throw new Error(`Unknown task: ${command}`);
  process.exitCode = status;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
