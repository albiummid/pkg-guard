# Pkg Guard

Inline vulnerability warnings and update suggestions for `package.json`.

| Folder | Contents |
|---|---|
| [`core/`](core) | Shared TypeScript logic and the JSON-RPC sidecar |
| [`platforms/vscode/`](platforms/vscode) | VS Code extension |
| [`platforms/jetbrains/`](platforms/jetbrains) | WebStorm / IntelliJ plugin (Kotlin) |

New platforms get their own folder under `platforms/` and reuse `core/`.
