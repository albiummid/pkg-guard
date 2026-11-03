# Pkg Guard core

Shared TypeScript logic (OSV, registry, lockfile, semver, fix computation) used by every platform.

Install the shared toolchain once from the repository root with `yarn install`.

- `src/server/server.ts` is a Node sidecar speaking line-delimited JSON-RPC over stdin/stdout (`scan`, `fixEffect`, `rangeEdits`, `compat`, `changelog`, `repoUrl`, `clearCache`). A new IDE/language integration only needs to spawn it and speak this protocol.
- `yarn cli core build:server` -> `core/dist/server.js`; `yarn cli core test` runs the unit tests (both commands run from the repository root).

## Layout (`src/`)

| Folder | Purpose |
|---|---|
| `utils/` | pure helpers (semver, range matching) |
| `manifest/` | package.json parsing/editing, package-manager detection |
| `vulnerabilities/` | OSV client, npm/yarn audit fallback, lockfile graphs |
| `updates/` | registry lookups, bump targets, peer/engines compatibility |
| `changelog/` | repository metadata and changelog slicing |
| `scan/` | scan orchestration and finding/fix building |
| `fixes/` | edits that apply a fix or update |
| `server/` | JSON-RPC sidecar entry point |
| `test/` | unit tests |
