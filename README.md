# Pkg Guard

Inline vulnerability warnings and update suggestions for `package.json`.

| Folder | Contents |
|---|---|
| [`core/`](core) | Shared TypeScript logic and the JSON-RPC sidecar |
| [`platforms/vscode/`](platforms/vscode) | VS Code extension |
| [`platforms/jetbrains/`](platforms/jetbrains) | WebStorm / IntelliJ plugin (Kotlin) |

New platforms get their own folder under `platforms/` and reuse `core/`.

## Versioning

The version lives only in [`version.yml`](version.yml). Change it with `node scripts/set-version.js <x.y.z>` (stamps `core`, `platforms/vscode` and `platforms/jetbrains`), or run it without an argument to re-sync. `node scripts/set-version.js --check` fails when a file is out of sync. When adding a platform, add it to the `targets` list in that script.

`version.yml` also pins the other versions: minimum VS Code (`vscode.engine`), the Node bundle target (`node.target`), and the JetBrains `sinceBuild`, IDE version and JVM. The Kotlin and IntelliJ Gradle plugin versions stay in `platforms/jetbrains/build.gradle.kts` because the `plugins {}` block can't read properties.
