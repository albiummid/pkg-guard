# Pkg Guard

Inline vulnerability warnings and update suggestions in `package.json`.

- **Inline ghost text** at the end of each dependency line: `⚠ 3 vulns → 4.18.1`, `↑ 11.2.8`, `⇡ 12.2.0 major`. Hover it for advisory details and one-click fixes.
- **Problems / squiggles** on the dependency (red = high/critical, yellow = moderate, blue = info).
- **Quick fixes** (lightbulb / `Ctrl+.`): update to the fixed version, pin a transitive package via `resolutions` (yarn) or `overrides` (npm), ignore an advisory, stop suggesting updates for a package.
- **Transitive vulnerabilities** are found from `yarn.lock` (v1) or `package-lock.json` (v2/3) and shown on the direct dependency that pulls them in, with the path (`@nestjs/platform-express › express › body-parser`).
- Status bar summary; click to re-scan.

## Sidebar (activity bar → Pkg Guard)

Every `package.json` in the workspace (monorepos included) as a project, with:

- **Scripts** – ▶ runs `npm|yarn|pnpm|bun run <script>` in a terminal; click jumps to the script.
- **Needs attention** – only the vulnerable / outdated dependencies.
- **dependencies / devDependencies / optionalDependencies** – red/yellow/blue icons, installed version, fix hints.
- **Actions** – install all, update all within the current major (patch/minor + vulnerability fixes), add dependency, re-scan.
- **Per dependency** (inline buttons + right-click): update to latest, update to a chosen version, open npm page, open repository, show changelog (installed → latest, from GitHub Releases or `CHANGELOG.md`), check compatibility, remove.

### Compatibility check

Before a version change, the target version's manifest is compared with the project:

- its `peerDependencies` against what is installed (npm-style range matching: `^ ~ x-ranges, >= <, hyphen, ||`),
- `engines.node` against the project's `engines.node`,
- added / removed dependencies, and ranges that conflict with what you pin,
- **installed packages whose own peer range would reject the new version**, with the newest release of each that accepts it offered as a *companion update* ("Update + N companions").

Limits: dependents are checked among your direct dependencies, using their installed `node_modules` manifests.

Data sources: [OSV.dev](https://osv.dev) for advisories (falls back to `yarn audit` / `npm audit` when offline) and the npm registry for versions.

Fixes only edit `package.json`; run your package manager afterwards to update the lockfile.

## Settings

| Setting | Default | |
|---|---|---|
| `pkgGuard.enableVulnerabilities` | `true` | |
| `pkgGuard.checkTransitive` | `true` | needs a supported lockfile |
| `pkgGuard.enableOutdated` | `true` | |
| `pkgGuard.showMajorUpdates` | `true` | |
| `pkgGuard.minSeverity` | `low` | `low` / `moderate` / `high` / `critical` |
| `pkgGuard.auditFallback` | `true` | |
| `pkgGuard.registry` | `https://registry.npmjs.org` | |
| `pkgGuard.ignoredAdvisories` | `[]` | |
| `pkgGuard.ignoredPackages` | `[]` | |

## Develop

```
cd platforms/vscode
yarn install
yarn typecheck
# F5 in VS Code (open the platforms/vscode/ folder) to launch an Extension Development Host
yarn package     # writes <repo root>/output/vscode/pkg-guard-0.1.0.vsix
code --install-extension <repo root>/output/vscode/pkg-guard-0.1.0.vsix
```

Shared logic lives in `core/` and is bundled into the extension by esbuild. Run its tests with `cd core && yarn test`.

Not supported yet: yarn berry / pnpm lockfiles (direct dependencies are still checked using `node_modules` or the declared range), single-line dependency sections, workspaces `catalog:` ranges.

## Source layout (`platforms/vscode/src/`)

`extension.ts` (activation), `commands/`, `views/` (tree), `services/` (workspace store, install).
