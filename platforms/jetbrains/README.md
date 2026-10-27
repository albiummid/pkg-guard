# Pkg Guard for JetBrains IDEs

Vulnerability warnings and update suggestions right inside `package.json`, including transitive dependencies. For WebStorm, IntelliJ IDEA and other JetBrains IDEs (build 242+).

![Inline warnings and Alt+Enter fixes](../../docs/media/jetbrains-inline.gif)

## Features

- **Inspections** on each dependency: known vulnerabilities and newer patch / minor / major versions.
- **Alt+Enter fixes**: update to the fixed version, pin a transitive package via `resolutions` / `overrides`, ignore an advisory.
- **Transitive vulnerabilities** from `yarn.lock` (v1) or `package-lock.json`, shown on the direct dependency that pulls them in.
- **Pkg Guard tool window** (right side): needs-attention list, update to latest or a chosen version, changelog, remove.

  ![Tool window](../../docs/media/jetbrains-toolwindow.gif)

- **Compatibility check** before an update: peer dependencies, `engines.node`, and companion updates.
- **Settings page** under *Settings | Tools | Pkg Guard*.

## Requirements

Node.js 18+ on the machine. If it is not found automatically, set its path in *Settings | Tools | Pkg Guard*.

## Install

Download the plugin `.zip`, then *Settings | Plugins | ⚙ | Install Plugin from Disk…*.

## Build from source

```bash
cd platforms/jetbrains
./gradlew buildPlugin   # zip lands in output/jetbrains/
./gradlew runIde        # sandbox IDE
```

The plugin bundles the shared scanner (`core/`) as a Node sidecar; the Gradle build runs `yarn build:server` in `core/` for you. See the [repository README](../../README.md) for the layout and versioning.
