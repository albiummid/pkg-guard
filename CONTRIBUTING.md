# Contributing to Pkg Guard

Thanks for helping out. This guide covers reporting issues and sending changes.

## Reporting issues

Search [existing issues](https://github.com/albiummid/pkg-guard/issues) first, then open a new one with the template that fits.

**Bug report** — include:
- Which IDE (VS Code or JetBrains), its version, and the Pkg Guard version (see `version.yml` or the installed extension).
- OS, Node.js version, and package manager (npm / yarn / pnpm / bun).
- Steps to reproduce, what you expected, and what happened. A minimal `package.json` (and the lockfile type) that reproduces it helps most.
- Logs: VS Code → *Output → Pkg Guard*; JetBrains → *Help → Show Log*.

**Feature request** — describe the problem first, then the behaviour you want. Say whether it applies to one IDE or all.

**Security issues** (for example a way a malicious `package.json` could run code) — don't open a public issue. Use GitHub's private vulnerability reporting on the repository's *Security* tab.

Incorrect or missing advisories come from [OSV.dev](https://osv.dev), so report those there. Report here only if Pkg Guard misreads OSV data or a lockfile.

## Project layout

| Folder | Contents |
|---|---|
| `core/` | Shared TypeScript logic and the JSON-RPC sidecar. Most features and fixes belong here so every IDE gets them. |
| `platforms/vscode/` | VS Code extension (UI only; calls into `core/`). |
| `platforms/jetbrains/` | JetBrains plugin in Kotlin (UI only; talks to the sidecar). |

Inside `core/src/`, code is grouped by feature: `utils/`, `manifest/`, `vulnerabilities/`, `updates/`, `changelog/`, `scan/`, `fixes/`, `server/`. Put new code in the matching folder, or add a new feature folder. See [`core/README.md`](core/README.md).

If you add or change a sidecar method, update the Kotlin types in `platforms/jetbrains/src/main/kotlin/dev/pkgguard/Model.kt` by hand. They mirror the TypeScript shapes and are not generated yet.

## Setup

Requirements: Node.js 18+, yarn 1.x, and JDK 17 (JetBrains plugin only).

```bash
cd core && yarn install && yarn test            # shared logic + tests
cd platforms/vscode && yarn install             # then F5 in VS Code on this folder
cd platforms/jetbrains && ./gradlew runIde      # sandbox IDE
```

Build artifacts land in `output/` (git-ignored):

```bash
cd platforms/vscode && yarn package             # -> output/vscode/*.vsix
cd platforms/jetbrains && ./gradlew buildPlugin # -> output/jetbrains/*.zip
```

## Making a change

1. Open or comment on an issue first for anything larger than a small fix, so we agree on the approach.
2. Branch from `master`: `feat/<short-name>` or `fix/<short-name>`.
3. Keep the change focused. Match the surrounding style and comment density.
4. Add or update tests in `core/src/test/` for logic changes. Run `cd core && yarn test`.
5. Run `yarn typecheck` in `platforms/vscode/` if you touched TypeScript used by the extension.
6. If you touched the sidecar or `core/`, build the JetBrains plugin once to confirm it still bundles.
7. Update the READMEs when behaviour or settings change. New settings go in `platforms/vscode/package.json`, the JetBrains settings page, and the settings table in `platforms/vscode/README.md`.

### Versions

Never edit versions by hand in `package.json` or `gradle.properties`. Change [`version.yml`](version.yml) and run `node scripts/set-version.js`. Check with `node scripts/set-version.js --check`. Version bumps are done by maintainers at release time, so don't include one in a feature PR.

`set-version.js` also takes `patch`, `minor` or `major` to bump from the current version, and `--print` to show it.

### Releasing (maintainers)

From a clean `master`:

```bash
node scripts/release.js patch --push    # or minor / major / x.y.z
yarn release:patch --push               # same thing; also release:minor and release:major (run from the repo root)
```

`yarn version:patch`, `version:minor` and `version:major` only bump and stamp the version files, without committing or tagging.

First it requires a clean `master` that is up to date with `origin` and runs the core tests, the VS Code typecheck and the version and changelog checks (`--skip-checks` skips them; `--help` shows usage). If any check fails, nothing is changed. Then it bumps `version.yml`, stamps every platform, updates `CHANGELOG.md`, commits `chore: release vX.Y.Z`, tags it and pushes. The tag starts `.github/workflows/release.yml`, which checks the tag against `version.yml` and the changelog, runs the tests, builds the `.vsix` and the plugin zip, and attaches both to a GitHub release whose notes are that version's section of `CHANGELOG.md` (tags with a `-` suffix are marked as pre-releases).

**Changelog.** `CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com): an `## [Unreleased]` section, then `## [x.y.z] - YYYY-MM-DD` sections with `### Added / Changed / Deprecated / Removed / Fixed / Security` groups. Write user-facing entries under Unreleased as changes land; the release script moves them under the new version. If Unreleased is empty, it builds the entries from Conventional Commit subjects since the last tag (`feat` → Added, `fix` → Fixed, `perf`/`refactor`/`revert` → Changed; `docs`, `chore`, `test` and `ci` are left out; `!` marks a breaking change). Curated entries read better than generated ones, so prefer writing them. `node scripts/changelog.js --check` validates the format and runs in CI. It then publishes only the stores whose secret exists: `VSCE_PAT` (VS Code Marketplace), `OVSX_PAT` (Open VSX), `JETBRAINS_PUBLISH_TOKEN` (JetBrains Marketplace). Before the first Marketplace publish, set a real `publisher` in `platforms/vscode/package.json` (it is `local` today). Pull requests and pushes to `master` run `.github/workflows/ci.yml` (version sync, core tests, VS Code typecheck and package, JetBrains build).

### Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org): `feat: ...`, `fix: ...`, `docs: ...`, `refactor: ...`, `test: ...`, `chore: ...`.
- One logical change per PR. Link the issue (`Closes #123`).
- Describe what changed and why, and how you tested it. Screenshots or GIFs help for UI changes.
- PRs need passing tests and a clean typecheck before review.

## Adding a new platform

Create `platforms/<name>/`, run the sidecar from `core/dist/server.js` (see [`core/README.md`](core/README.md) for the protocol), copy its final artifact to `output/<name>/`, and add it to the `targets` list in `scripts/set-version.js`.

## License

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
