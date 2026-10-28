// CHANGELOG.md in the Keep a Changelog format (https://keepachangelog.com), kept by hand and by this script.
//   node scripts/changelog.js add <version>    -> turn [Unreleased] into [<version>]. If [Unreleased] is empty, it is built from
//                                                  the Conventional Commits since the last v* tag. Called by scripts/release.js.
//   node scripts/changelog.js notes <version>  -> print that version's section (used as the GitHub release body)
//   node scripts/changelog.js --check          -> exit 1 if the file does not follow the format
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'CHANGELOG.md');
const HEADER = `# Changelog

All notable changes to Pkg Guard are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/). Add entries under **Unreleased** as you go; \`scripts/release.js\`
moves them under the new version. If Unreleased is empty at release time, entries are generated from the commit messages.
`;
const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
// Conventional Commit type -> changelog section. Types not listed (docs, chore, test, ci, build, style) stay out of the changelog.
const TYPE = { feat: 'Added', fix: 'Fixed', perf: 'Changed', refactor: 'Changed', revert: 'Changed' };

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const read = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : HEADER + '\n## [Unreleased]\n');

/** [{ name: 'Unreleased' | '1.2.3', date?, body }] in file order, plus the text before the first section. */
function parse(text) {
  const parts = text.split(/^## /m);
  const head = parts.shift();
  const sections = parts.map((p) => {
    const nl = p.indexOf('\n');
    const title = p.slice(0, nl < 0 ? undefined : nl);
    const m = /^\[([^\]]+)\](?:\s+-\s+(\S+))?/.exec(title);
    const body = nl < 0 ? '' : p.slice(nl + 1);
    return { name: m ? m[1] : title, date: m?.[2], body: body.replace(/\n\[[^\]]+\]: \S+\s*$/gm, '').trim() };
  });
  return { head, sections };
}

function repoUrl() {
  try {
    return git('remote', 'get-url', 'origin').replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
  } catch {
    return '';
  }
}

function render({ head, sections }) {
  const out = [head.trimEnd(), ''];
  for (const s of sections) {
    out.push(s.name === 'Unreleased' ? '## [Unreleased]' : `## [${s.name}] - ${s.date}`, '');
    if (s.body) out.push(s.body, '');
  }
  const url = repoUrl();
  if (/^https?:\/\//.test(url)) {
    const versions = sections.filter((s) => s.name !== 'Unreleased').map((s) => s.name);
    const links = [];
    if (versions.length && sections.some((s) => s.name === 'Unreleased')) links.push(`[Unreleased]: ${url}/compare/v${versions[0]}...HEAD`);
    versions.forEach((v, i) => links.push(`[${v}]: ${i + 1 < versions.length ? `${url}/compare/v${versions[i + 1]}...v${v}` : `${url}/releases/tag/v${v}`}`));
    out.push(...links, '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Release notes from the commit subjects since the last v* tag, grouped by changelog section. */
function fromCommits() {
  let range = [];
  try {
    range = [`${git('describe', '--tags', '--abbrev=0', '--match', 'v*')}..HEAD`];
  } catch {
    /* no tag yet: everything */
  }
  const groups = new Map(SECTIONS.map((s) => [s, []]));
  for (const line of git('log', ...range, '--no-merges', '--pretty=format:%s').split('\n')) {
    const m = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/.exec(line.trim());
    if (!m || /^release v?\d/.test(m[4])) continue;
    const [, type, scope, breaking, subject] = m;
    const section = TYPE[type];
    if (!section) continue;
    const text = subject.charAt(0).toUpperCase() + subject.slice(1);
    groups.get(section).push(`- ${breaking ? '**Breaking:** ' : ''}${scope ? `**${scope}:** ` : ''}${text}`);
  }
  return SECTIONS.filter((s) => groups.get(s).length)
    .map((s) => `### ${s}\n\n${groups.get(s).join('\n')}`)
    .join('\n\n');
}

function check(text) {
  const { sections } = parse(text);
  const problems = [];
  if (!/^# Changelog\n/.test(text)) problems.push('must start with "# Changelog"');
  if (sections[0]?.name !== 'Unreleased') problems.push('first section must be "## [Unreleased]"');
  for (const s of sections.slice(1)) {
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(s.name) || !/^\d{4}-\d{2}-\d{2}$/.test(s.date ?? '')) problems.push(`bad heading for "${s.name}": use "## [x.y.z] - YYYY-MM-DD"`);
  }
  for (const s of sections) {
    for (const h of s.body.match(/^### .*$/gm) ?? []) if (!SECTIONS.includes(h.slice(4))) problems.push(`[${s.name}] unknown section "${h}"`);
  }
  return problems;
}

const [cmd, version] = process.argv.slice(2);
if (cmd === '--check') {
  const problems = check(read());
  problems.forEach((p) => console.error(`CHANGELOG.md: ${p}`));
  process.exit(problems.length ? 1 : 0);
} else if (cmd === 'notes' && version) {
  const s = parse(read()).sections.find((x) => x.name === version);
  if (!s || !s.body) { console.error(`CHANGELOG.md has no notes for ${version}.`); process.exit(1); }
  console.log(s.body);
} else if (cmd === 'add' && version) {
  const doc = parse(read());
  if (doc.sections.some((s) => s.name === version)) { console.error(`CHANGELOG.md already has ${version}.`); process.exit(1); }
  const unreleased = doc.sections.find((s) => s.name === 'Unreleased');
  const body = unreleased?.body || fromCommits();
  if (!body) { console.error('Nothing to release: Unreleased is empty and no feat/fix/perf/refactor commits were found.'); process.exit(1); }
  const rest = doc.sections.filter((s) => s.name !== 'Unreleased');
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(file, render({ head: doc.head, sections: [{ name: 'Unreleased', body: '' }, { name: version, date: today, body }, ...rest] }));
  console.log(`CHANGELOG.md: added ${version}`);
} else {
  console.error('Usage: node scripts/changelog.js add <version> | notes <version> | --check');
  process.exit(1);
}
