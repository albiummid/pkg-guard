// Runs the in-editor tests (src/test) inside a real VS Code. Each scenario is its own VS Code launch, because trust,
// the folder and the first activation event cannot be changed from inside a running window.
// VS Code version: the minimum the extension supports (engines.vscode), or PKG_GUARD_VSCODE_VERSION (e.g. "stable").
// Usage: node scripts/test.js [scenario]
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');

const pkgDir = path.resolve(__dirname, '..');
const dist = path.join(pkgDir, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const version = process.env.PKG_GUARD_VSCODE_VERSION || manifest.engines.vscode.replace(/^[\^~>=\s]+/, '');

const manifestJson = JSON.stringify({ name: 'pkg-guard-fixture', version: '1.0.0', dependencies: { 'left-pad': '^1.3.0' } }, null, 2);

/** A throwaway workspace. node_modules exists but is empty, so the dependency is "not installed": a Finding with no network. */
function workspace(name, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pkg-guard-${name}-`));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

// registry and installAfterFix are restricted settings; the other two keep the scans offline
const workspaceSettings = JSON.stringify({
  'pkgGuard.enableVulnerabilities': false,
  'pkgGuard.enableOutdated': false,
  'pkgGuard.registry': 'http://workspace.invalid',
  'pkgGuard.installAfterFix': 'auto',
});

const scenarios = [
  { name: 'workspace', target: () => workspace('workspace', { 'package.json': manifestJson, '.vscode/settings.json': workspaceSettings }) },
  { name: 'empty', target: () => workspace('empty', {}) },
  // a package.json opened on its own, with no folder
  { name: 'lone', target: () => path.join(workspace('lone', { 'package.json': JSON.stringify({ name: 'lone' }) }), 'package.json') },
];

function launch(executable, scenario, work) {
  const target = scenario.target();
  const userData = path.join(work, `${scenario.name}-user`);
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify({
            'workbench.startupEditor': 'none',
      // the built-in npm extension opens package.json files on its own, which would reopen the document a test just closed
      'npm.autoDetect': 'off',
      'task.autoDetect': 'off',
      'telemetry.telemetryLevel': 'off',
    }),
  );
  const args = [
    target,
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--no-cached-data',
    '--disable-extensions',
    `--user-data-dir=${userData}`,
    `--extensions-dir=${path.join(work, `${scenario.name}-ext`)}`,
    `--extensionDevelopmentPath=${pkgDir}`,
    `--extensionTestsPath=${path.join(dist, 'test', 'suite.js')}`,
  ];
  // VS Code treats every workspace as trusted while extension tests run, so no scenario can be untrusted
  args.push('--disable-workspace-trust');
  console.log(`\n== ${scenario.name} (VS Code ${version}) ==`);
  const env = { ...process.env, PKG_GUARD_SCENARIO: scenario.name };
  delete env.ELECTRON_RUN_AS_NODE;
  return cp.spawnSync(executable, args, { stdio: 'inherit', env }).status === 0;
}

async function main() {
  const only = process.argv[2];
  // the extension bundle, and the tests as one output file per source file (VS Code loads them with require)
  cp.execSync('yarn compile', { cwd: pkgDir, stdio: 'inherit' });
  const tests = fs.readdirSync(path.join(pkgDir, 'src/test')).filter((f) => f.endsWith('.ts')).map((f) => path.join(pkgDir, 'src/test', f));
  esbuild.buildSync({ entryPoints: tests, outdir: path.join(dist, 'test'), platform: 'node', format: 'cjs', target: 'node24' });

  const executable = await downloadAndUnzipVSCode({ version, cachePath: process.env.PKG_GUARD_VSCODE_CACHE || path.join(pkgDir, '.vscode-test') });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-guard-vscode-test-'));
  const failed = scenarios.filter((s) => !only || s.name === only).filter((s) => !launch(executable, s, work)).map((s) => s.name);
  if (failed.length) {
    console.error(`\nFailed: ${failed.join(', ')}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
