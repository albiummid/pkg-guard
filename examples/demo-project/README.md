# Pkg Guard demo project

An intentionally out-of-date npm monorepo used to record the GIFs in [`docs/media/`](../../docs/media). **Do not use these dependencies in real projects**: they carry known vulnerabilities on purpose.

It is not part of the repository's yarn workspace, so `yarn install`, CI and the typecheck ignore it.

## What it contains

| Project | Dependency | Shows |
|---|---|---|
| `packages/api` | `lodash` 4.17.15 | direct vulnerability, quick fix to the fixed version |
| | `axios` 0.21.1 | direct vulnerabilities, plus a newer major |
| | `express` 4.17.1 | transitive vulnerabilities (`body-parser`, `qs`, …) with a pin via `overrides` |
| | `request` 2.88.2 | deprecated package, plus transitive vulnerabilities |
| | `typescript` 5.3.3 | minor update available |
| `packages/web` | `moment` 2.29.1 | direct vulnerability |
| | `react`, `react-dom` 17.0.2 | major update and the compatibility check |
| | `@testing-library/react` 12.1.5 | its peer range rejects React 19, so it is offered as a companion update |
| | `typescript` 5.3.3 | minor update available |

Versions come from the committed `package-lock.json`, so the *installed* versions stay old even though the declared ranges (`^4.17.15`, …) would allow newer ones. Advisory data and "latest" versions change over time, so what the extension shows will drift; re-record when it does.

## Setup

```bash
cd examples/demo-project
npm install --ignore-scripts
```

The install is needed for the **compatibility check**, which reads the installed packages' manifests from `node_modules`. Warnings and quick fixes work from the lockfile alone. `node_modules` is git-ignored.

Reset between takes, since quick fixes edit the `package.json` files:

```bash
git restore examples/demo-project
```

## Open it

**VS Code.** Install the packaged extension in a clean profile so recordings match what Marketplace users get:

```bash
yarn cli vscode install --profile pkg-guard-demo
code --profile pkg-guard-demo examples/demo-project
```

To test unreleased code instead, use `code --extensionDevelopmentPath=platforms/vscode examples/demo-project`.

**JetBrains.** `cd platforms/jetbrains && ./gradlew runIde`, then open `examples/demo-project` in the sandbox IDE.

## Recording

- About 800 px wide, under 5 MB, 10 to 15 seconds, ~12 fps. Hide notifications and personal tabs first.
- Any screen recorder that exports GIF works (for example ScreenToGif on Windows); `gifsicle -O3 --lossy=80` shrinks the file.
- Save with the exact names in [`docs/media/README.md`](../../docs/media/README.md) and push them to `master`, because the VS Code README links to `raw.githubusercontent.com`.

### `vscode-inline.gif`
1. Open `packages/api/package.json` and wait for the hints (a vulnerability hint with the fixed version on `lodash`, `↑ …` on `typescript`).
2. Hover `lodash` to show the advisory list.
3. Press `Ctrl+.` on `lodash` and choose the update to the fixed version.
4. Scroll to `express`, hover the transitive warning, and apply the `overrides` pin.

### `vscode-sidebar.gif`
1. Open **Pkg Guard** in the activity bar: both projects (`api`, `web`) appear, with **Scripts** and **Needs attention**.
2. Click ▶ on a script to run it in a terminal.
3. On `react`, choose *Check compatibility* to show `react-dom` and `@testing-library/react` as companion updates.
4. Show *Changelog* for a dependency, then *Update to latest*.

### `jetbrains-inline.gif`
1. Open `packages/api/package.json` in the sandbox IDE.
2. Show the inspections on `lodash`, then press `Alt+Enter` and apply the fix to the fixed version.

### `jetbrains-toolwindow.gif`
1. Open the **Pkg Guard** tool window (right side).
2. Show the needs-attention list, run the compatibility check on `react`, then update a dependency and show its changelog.
