# Pkg Guard for JetBrains IDEs

Vulnerability warnings and update suggestions right inside `package.json`, including transitive dependencies. For WebStorm, IntelliJ IDEA and other JetBrains IDEs (build 242+).

![Pkg Guard in a package.json with the tool window](../../docs/media/jetbrains-package-json-with-sidebar.png)

## Features

- **Inspections** on each dependency: known vulnerabilities and newer patch / minor / major versions.
- **End-of-line hints** like `⚠ 3 vulns → 4.18.1` on dependency lines, colored by severity.
- **Import warnings** in JS / TS files: vulnerable packages are flagged on their `import` / `require` lines, with an end-of-line hint.
- **Alt+Enter fixes**: update to the fixed version, pin a transitive package via `resolutions` / `overrides`, ignore an advisory.
- **Transitive vulnerabilities** from `yarn.lock` (v1) or `package-lock.json`, shown on the direct dependency that pulls them in.
- **Pkg Guard tool window** (right side): needs-attention list, update to latest or a chosen version, changelog, remove.

  ![Tool window](../../docs/media/jetbrains-toolwindow.gif)

- **Compatibility check** before an update: peer dependencies, `engines.node`, and companion updates.
- **Settings page** under *Settings | Tools | Pkg Guard*.

## Requirements

Node.js 24 or newer on the machine. If it is not found automatically, set its path in *Settings | Tools | Pkg Guard*.

## Install

Download the plugin `.zip`, then *Settings | Plugins | ⚙ | Install Plugin from Disk…*.

## Build from source

```bash
# From the repository root, install the shared toolchain once with `yarn install`.
yarn cli jetbrains build    # zip lands in output/jetbrains/
yarn cli jetbrains run      # sandbox IDE
yarn cli jetbrains verify   # plugin verifier
```

The plugin bundles the shared scanner (`src/`) as a Node sidecar; the Gradle build runs `yarn cli core build:server` from the repository root. See the [repository README](../../README.md) for the layout and versioning.
