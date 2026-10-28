// Cut a release locally: check everything, bump version.yml, stamp every platform, update CHANGELOG.md, commit and tag.
// Pushing the tag starts .github/workflows/release.yml, which builds both installers and publishes the GitHub release.
//   node scripts/release.js patch|minor|major|x.y.z [--push] [--skip-checks]
//   node scripts/release.js --help
const { execFileSync, execSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const bump = args.find((a) => !a.startsWith('--'));

if (flags.has('--help') || !bump) {
  console.log(`Usage: node scripts/release.js patch|minor|major|x.y.z [--push] [--skip-checks]

  Before bumping it requires a clean master that is up to date with origin, then runs the core tests, the
  VS Code typecheck, and the version and changelog checks (--skip-checks skips these four).
  It then bumps version.yml, stamps every platform, moves CHANGELOG.md's Unreleased section under the new
  version, commits "chore: release vX.Y.Z" and tags it. --push also pushes master and the tag, which starts
  the Release workflow on GitHub. Without --push it prints the push command.`);
  process.exit(bump || flags.has('--help') ? 0 : 1);
}

const run = (cmd, a) => execFileSync(cmd, a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const step = (title, cmd, cwd = '.') => {
  console.log(`\n> ${title}`);
  try {
    execSync(cmd, { cwd: path.join(root, cwd), stdio: 'inherit' });
  } catch {
    console.error(`\nFailed: ${title}. Nothing was changed.`);
    process.exit(1);
  }
};
const fail = (msg) => { console.error(msg); process.exit(1); };

if (run('git', ['status', '--porcelain'])) fail('Working tree is not clean. Commit or stash first.');
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'master') fail(`Release from master, not ${branch}.`);

try {
  run('git', ['fetch', 'origin', 'master']);
  const behind = Number(run('git', ['rev-list', '--count', 'HEAD..origin/master']));
  const ahead = Number(run('git', ['rev-list', '--count', 'origin/master..HEAD']));
  if (behind) fail(`master is ${behind} commit(s) behind origin. Pull first.`);
  if (ahead && flags.has('--push')) console.log(`Note: ${ahead} unpushed commit(s) on master will be pushed with the release.`);
} catch {
  console.log('Could not reach origin; skipping the up-to-date check.');
}

if (!flags.has('--skip-checks')) {
  step('Core tests', 'yarn test', 'core');
  step('VS Code typecheck', 'yarn typecheck', 'platforms/vscode');
  step('Versions in sync', 'node scripts/set-version.js --check');
  step('Changelog format', 'node scripts/changelog.js --check');
}

run('node', ['scripts/set-version.js', bump]);
const version = run('node', ['scripts/set-version.js', '--print']);
const tag = `v${version}`;
if (run('git', ['tag', '--list', tag])) {
  run('git', ['checkout', '--', '.']);
  fail(`Tag ${tag} already exists.`);
}
try {
  run('node', ['scripts/changelog.js', 'add', version]); // before tagging: it reads commits since the previous tag
} catch {
  run('git', ['checkout', '--', '.']);
  fail('Release aborted and the version bump was reverted.');
}

run('git', ['add', '-A']);
run('git', ['commit', '-m', `chore: release ${tag}`]);
run('git', ['tag', '-a', tag, '-m', `Pkg Guard ${tag}`]);
console.log(`\nCommitted and tagged ${tag}.`);

if (flags.has('--push')) {
  run('git', ['push', 'origin', 'master', tag]);
  console.log(`Pushed ${tag}; the Release workflow is running (GitHub > Actions).`);
} else {
  console.log(`Push with: git push origin master ${tag}`);
}
