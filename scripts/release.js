// Cut a release locally: bump version.yml, stamp every platform, update CHANGELOG.md, commit and tag. Pushing the tag starts .github/workflows/release.yml.
//   node scripts/release.js patch|minor|major|x.y.z [--push]
const { execFileSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const [bump, flag] = process.argv.slice(2);
if (!bump) { console.error('Usage: node scripts/release.js patch|minor|major|x.y.z [--push]'); process.exit(1); }

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

if (run('git', ['status', '--porcelain'])) { console.error('Working tree is not clean. Commit or stash first.'); process.exit(1); }
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'master') { console.error(`Release from master, not ${branch}.`); process.exit(1); }

run('node', ['scripts/set-version.js', bump]);
const version = run('node', ['scripts/set-version.js', '--print']);
const tag = `v${version}`;
if (run('git', ['tag', '--list', tag])) { console.error(`Tag ${tag} already exists.`); process.exit(1); }
run('node', ['scripts/changelog.js', 'add', version]); // before tagging: it reads commits since the previous tag

run('git', ['add', '-A']);
run('git', ['commit', '-m', `chore: release ${tag}`]);
run('git', ['tag', '-a', tag, '-m', `Pkg Guard ${tag}`]);
console.log(`Committed and tagged ${tag}.`);

if (flag === '--push') {
  run('git', ['push', 'origin', 'master', tag]);
  console.log(`Pushed ${tag}; the release workflow is running.`);
} else {
  console.log(`Push with: git push origin master ${tag}`);
}
