// Single source of truth: <repo root>/version.yml.
//   node scripts/set-version.js          -> stamp version.yml into every platform
//   node scripts/set-version.js 0.2.0    -> set the product version first, then stamp
//   node scripts/set-version.js --check  -> exit 1 if any file is out of sync
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const ymlFile = path.join(root, 'version.yml');

// Minimal parser for version.yml: top-level `key: value` and one level of nesting -> { 'vscode.engine': '1.85.0' }
function readConfig() {
  const cfg = {};
  let section = '';
  for (const raw of fs.readFileSync(ymlFile, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    const m = /^(\s*)([\w.]+):\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    if (!m[1]) { if (m[3]) { cfg[m[2]] = m[3]; section = ''; } else section = m[2] + '.'; }
    else cfg[section + m[2]] = m[3];
  }
  return cfg;
}

const arg = process.argv[2];
const check = arg === '--check';
if (arg && !check) {
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(arg)) { console.error(`Invalid version: ${arg}`); process.exit(1); }
  fs.writeFileSync(ymlFile, fs.readFileSync(ymlFile, 'utf8').replace(/^version:.*$/m, `version: ${arg}`));
}
const c = readConfig();
for (const k of ['version', 'vscode.engine', 'node.target', 'jetbrains.sinceBuild', 'jetbrains.ideaVersion', 'jetbrains.jvm']) {
  if (!c[k]) { console.error(`version.yml is missing "${k}"`); process.exit(1); }
}

const setProps = (text, props) => {
  for (const [k, v] of Object.entries(props)) {
    const re = new RegExp(`^${k.replace(/\./g, '\.')}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : text.replace(/\s*$/, '\n') + `${k}=${v}\n`;
  }
  return text;
};
const editJson = fn => text => { const o = JSON.parse(text); fn(o); return JSON.stringify(o, null, 2) + '\n'; };
const esbuildTarget = text => text.replace(/--target=node\d+/g, `--target=node${c['node.target']}`);

// Add an entry here when a new platform is introduced.
const targets = [
  { file: 'core/package.json', edit: text => esbuildTarget(editJson(o => { o.version = c.version; })(text)) },
  {
    file: 'platforms/vscode/package.json',
    edit: text => esbuildTarget(editJson(o => {
      o.version = c.version;
      o.engines.vscode = `^${c['vscode.engine']}`;
      o.devDependencies['@types/vscode'] = c['vscode.engine'];
    })(text)),
  },
  {
    file: 'platforms/jetbrains/gradle.properties',
    edit: text => setProps(text, {
      version: c.version,
      'pkgguard.sinceBuild': c['jetbrains.sinceBuild'],
      'pkgguard.ideaVersion': c['jetbrains.ideaVersion'],
      'pkgguard.jvm': c['jetbrains.jvm'],
    }),
  },
];

let drift = false;
for (const t of targets) {
  const p = path.join(root, t.file);
  const text = fs.readFileSync(p, 'utf8');
  const next = t.edit(text);
  if (next === text) continue;
  if (check) { drift = true; console.error(`out of sync: ${t.file}`); }
  else fs.writeFileSync(p, next);
}
if (check) process.exit(drift ? 1 : 0);
console.log(`version ${c.version} applied`);
