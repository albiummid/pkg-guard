# Pkg Guard for JetBrains

`platforms/jetbrains/` holds a WebStorm / IntelliJ plugin that reuses the same scanner: `yarn build:server` (in `core/`) bundles `core/src/server/server.ts` into `core/dist/server.js`, which the plugin runs with Node 18+ (set the path in *Settings | Tools | Pkg Guard*). It provides inspections with Alt+Enter fixes on `package.json`, a **Pkg Guard** tool window, the peer/engines compatibility check with companion updates, and a settings page.

```
cd platforms/jetbrains
./gradlew buildPlugin   # zip in output/jetbrains, installable via "Install Plugin from Disk…"
./gradlew runIde        # sandbox IDE
```
