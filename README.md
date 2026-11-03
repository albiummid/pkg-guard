# Pkg Guard

Vulnerability warnings and update suggestions right inside your `package.json`, including **transitive** dependencies, with safe one-click fixes. Available for VS Code and the JetBrains IDEs (WebStorm, IntelliJ IDEA, …).

![Pkg Guard in VS Code](docs/media/vscode-inline.gif)

## Features

- **Inline warnings** next to each dependency: known vulnerabilities, newer patch / minor / major versions.
- **Transitive vulnerabilities** from `yarn.lock` (v1) or `package-lock.json`, shown on the direct dependency that pulls them in.
- **One-click fixes**: update to the fixed version, pin a transitive package via `resolutions` / `overrides`, ignore an advisory.
- **Compatibility check** before an update: peer dependencies, `engines.node`, and companion updates for packages that would break.
- **Changelog** between your installed version and the target.
- Works with npm, yarn, pnpm and bun. Advisories come from [OSV.dev](https://osv.dev), versions from the npm registry.

## Install

| IDE | Package | Guide |
|---|---|---|
| VS Code | `.vsix` | [src/platforms/vscode](src/platforms/vscode) |
| WebStorm / IntelliJ IDEA | plugin `.zip` | [src/platforms/jetbrains](src/platforms/jetbrains) |

Fixes only edit `package.json`; run your package manager afterwards to refresh the lockfile.

## Repository layout

| Folder | Contents |
|---|---|
| [`src/core/`](src/core) | Shared TypeScript logic and the JSON-RPC sidecar used by every platform |
| [`src/platforms/vscode/`](src/platforms/vscode) | VS Code extension |
| [`src/platforms/jetbrains/`](src/platforms/jetbrains) | WebStorm / IntelliJ plugin (Kotlin) |
| [`docs/media/`](docs/media) | Demo GIFs used in the READMEs |
| `output/` | Build artifacts (git-ignored) |

A new IDE or language gets its own folder under `src/platforms/` and reuses `src/core/`.

## Development

```bash
# shared logic
cd src/core && yarn install && yarn test

# VS Code extension -> output/vscode/*.vsix
cd src/platforms/vscode && yarn install && yarn package

# JetBrains plugin -> output/jetbrains/*.zip
cd src/platforms/jetbrains && ./gradlew buildPlugin
```

### Versions

All versions live in [`version.yml`](version.yml): the product version, minimum VS Code, Node bundle target, and the JetBrains `sinceBuild`, IDE version and JVM.

```bash
yarn cli                         # choose a repository task interactively
yarn cli version 0.2.0           # set the product version and stamp every platform
yarn cli version                 # re-sync after editing version.yml
yarn cli version --check         # fail if a file is out of sync
```

When adding a platform, add it to the targets list in `scripts/cli.js`. The Kotlin and IntelliJ Gradle plugin versions stay in `src/platforms/jetbrains/build.gradle.kts` because the `plugins {}` block can't read properties.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first for how to report bugs, set up the project and submit changes.

## License

[MIT](LICENSE)
