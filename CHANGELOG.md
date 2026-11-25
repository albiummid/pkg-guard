# Changelog

All notable changes to Pkg Guard are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/). Add entries under **Unreleased** as you go; `yarn cli release`
moves them under the new version. If Unreleased is empty at release time, entries are generated from the commit messages.

## [Unreleased]

### New Feature

- Transitive vulnerabilities are now found in projects that use yarn berry (v2 and later) lockfiles, including packages installed under an npm alias and each workspace member; the "lockfile not supported" note no longer appears for them.
- Transitive vulnerabilities are found in projects with a `pnpm-lock.yaml` (lockfile formats v5, v6 and v9), shown on the direct dependency that pulls them in; in a pnpm workspace each member is read from its own importer entry, and a Pin goes to `pnpm.overrides` in the workspace root.
- A project with a `bun.lock` gets Transitive vulnerability checks, attributed to the direct dependency that pulls them in; the binary `bun.lockb` is still not supported and keeps its scan note. A Pin goes to `overrides`, which bun reads.
- Registry lookups honour per-scope registries and authentication from `.npmrc` (user file, and the project's in a trusted workspace); credentials go only to the registry they belong to.
- JetBrains: each project in the tool window has a "Needs attention (n)" group on top listing the dependencies with a vulnerability, transitive vulnerability, deprecation or out-of-sync install, with the same actions as the dependencies below; it is hidden when nothing needs attention.
- JetBrains: a version under a dependency offers "Changelog: installed to this" and "Changelog: this version only", opening the release notes in the changelog viewer with their source named (the npm page when the package has no repository).
- JetBrains: a project's menu in the tool window has "Fix vulnerabilities": after a confirmation that lists them, it updates vulnerable dependencies (in every section that declares them) and pins Transitive vulnerabilities in the workspace root's `package.json`, then offers the install once.
- JetBrains: the tool window shows each project's scan notes (unsupported lockfile, dependencies not checked, audit fallback) under an expandable "Notes (n)" entry with the data source of the last scan; a failed vulnerability check is shown in red.
- JetBrains: a status bar widget shows how many dependencies are vulnerable and how many updates are available (the tooltip names the data source); clicking it re-scans with fresh advisory and registry data.
- With no lockfile and no `node_modules`, a dependency is checked against every published version its range allows instead of only the lowest one, so an advisory that affects only a later allowed release (a malicious publish, for example) is reported as "may be vulnerable", naming the affected versions, with a fix that raises the range past them. It costs one OSV.dev query per dependency, plus the details of each of the package's advisories (cached), and no extra registry requests; with update checks off or no registry data only the lowest version is checked, as before, and a scan note says so.
- JetBrains: a project without a `package.json` shows "No package.json found" and what Pkg Guard needs in the tool window, instead of an empty tree; it never shows while existing manifests are still being scanned.
- The upgrade report audits the project's `resolutions` / `overrides` (yarn, including scoped keys such as `**/parent/pkg`; npm; bun; `pnpm.overrides`) in a new Overrides section: each entry is compared with what the packages requesting it would get without it, and marked still needed (that version has an Advisory), no longer needed, forcing another major on a package that would be safe without it, or unused. Nested npm overrides and pnpm or bun lockfiles are listed as not checked. With yarn v1 it reminds that removing a resolution leaves the old version locked until its lockfile entries are re-resolved.

- JetBrains: the scanner uses the IDE's HTTP proxy settings for advisory and registry requests (manual HTTP proxy; credentials are never logged). VS Code uses the editor proxy.

### Fixes

- JetBrains: "Add dependency…" reports a failed registry lookup (network, registry error) separately from a package that does not exist, and no longer fails on a package that has deprecated versions.
- JetBrains: after Add dependency, Remove dependency, an Update or a Fix, `package.json` is saved even when no install runs (install setting "never", an untrusted project, or no known package manager).
- JetBrains: "Fix vulnerabilities" plans against the current editor text, and the status bar stops counting a `package.json` that was deleted.
- JetBrains: every `package.json` of a project is now scanned in the background once indexing is done, so Findings, the tool window and import warnings are ready without opening anything.
- A failed `npm audit` / `yarn audit` fallback (offline, an error report, the old npm 6 format) is now reported as a failed check instead of "no vulnerabilities".
- npm workspace members are checked against their own nested copy of a package, not the root's.
- Packages installed under an npm alias are looked up under their real name; peer dependencies npm installed are followed.
- Advisories without a severity rating (and malware records) are no longer hidden by `minSeverity`; the severity is read from the CVSS score when there is no rating. Advisories can be ignored by any of their ids, including the CVE id.
- A failed advisory lookup is retried by the next scan instead of being remembered as "unknown severity, no fix"; concurrent scans share OSV and registry requests, and result pages are followed.
- Compact or one-line `dependencies` sections are found; dependencies that cannot be located, have no known version, or sit in a lockfile that is not supported (pnpm, bun) now produce a scan note.
- A Pin is written to the workspace root's `package.json`, keeps the file's formatting and an existing nested npm override, and is not offered when it would force several majors of a package or when the package is also a direct dependency. A `>=` range keeps its operator when updated; an update's title counts only the advisories it fixes.
- Dist-tag ranges (`next`, `canary`) are no longer reported as out of sync.
- JetBrains: "Add dependency…" in a project's menu in the tool window looks up the newest stable version, inserts it sorted into dependencies or devDependencies as one undoable edit, and offers the install.
- JetBrains: an install after an Update or Pin saves `package.json` first, so it installs the new versions.
- JetBrains: one scan per `package.json` (no more cascade of duplicate scans when the tool window opens), an older scan never replaces a newer result, Cancel interrupts a scan, a timeout says which call timed out, applying settings no longer fails running scans, and a scanner error is shown again after it had recovered.
- JetBrains: a Node.js older than 24 now gets a clear message instead of a scanner that starts and fails; the plugin only calls Kotlin standard library functions that exist in IDE 242 (which bundles Kotlin 1.9), so it cannot fail at runtime on the oldest supported IDE; closing a project cancels its refresh.
- A Pin is also not offered when the workspace root manifest it is written to declares the package; VS Code "Fix vulnerabilities" checks that root before it changes anything, so it cannot stop half way.
- JetBrains: "Update to" only offers versions newer than the installed one; Update, Update all and Changelog scan first when the project has not been scanned yet; a change in one project no longer re-scans the others; bun lockfiles and `npm-shrinkwrap.json` are watched.
- JetBrains: dependencies in the tool window can be removed from the context menu: after a confirmation the dependency is removed from every section that declares it (an emptied section is dropped) as one undoable edit, and the install is offered afterwards.
- JetBrains: removes the use of the platform APIs deprecated in 2025.2 and 2026.3, builds for Java 21, and CI now runs the plugin verifier (failing on compatibility problems and deprecated API use) against IDE builds 242, 252 and 2026.3.
- VS Code: workspace settings for the registry, install-after-fix and the audit fallback are ignored in untrusted workspaces; granting trust re-scans.
- VS Code: fix titles are escaped in the hover, a hover link applies the Fix it shows even after a re-scan, a Fix is refused when the line changed since the scan, scripts run as a quoted task, installs use the terminal's working directory, and only web links from registry data are opened.
- VS Code: only real `package.json` files on disk are scanned (not diff views), a closed file no longer gets its diagnostics back, a newer scan result is never replaced by an older one, "Re-scan" fetches fresh data, and the welcome view shows when there is no `package.json`.

### Improvements

- Re-scan every project periodically (every 6 hours by default) with fresh advisory data, so new vulnerabilities show up in an editor left open. Set `pkgGuard.refreshIntervalHours` (or the JetBrains setting) to change it, or 0 to turn it off.
- JetBrains: editing package.json now refreshes the import warnings of open JS / TS files.
- VS Code: import warnings remember the nearest `package.json` of a folder instead of walking the file system on every edit, until a `package.json` is created, deleted or moved.

### New Feature

- JetBrains: a "Pkg Guard: Re-scan" action in Find Action, the Tools menu and the editor popup of a `package.json` clears the caches and re-scans every project, like the tool window Refresh; it also works while the IDE is indexing.
- Import warnings: vulnerable dependencies are flagged on their `import` / `require` lines in JS and TS files (end-of-line text, hover and Problems in VS Code; inspections in JetBrains). Toggle with `pkgGuard.importWarnings` or the JetBrains settings page.
- JetBrains: end-of-line hints like VS Code (`⚠ 3 vulns → 4.18.1`) on package.json dependency lines and import lines.
- JetBrains: vulnerability findings and import warnings offer an "Open advisory" action (Alt+Enter) that opens the advisory page (http and https links only), and their tooltip names the advisory id.

## [0.1.3] - 2026-10-28

### Fixes

- Remove unnecessary quotes in test script path in package.json

## [0.1.2] - 2026-10-28

### New Feature

- Implement upgrade report functionality with markdown output and UI integration
- Add the Pkg Guard JetBrains plugin for inline vulnerability warnings and package updates

### Improvements

- Update version across all relevant files and add release checks
- Add CI and release workflows, changelog management, and versioning scripts
- Add domain documentation, issue tracker guidelines, and triage labels; refactor severity to level in findings
- Add issue and pull request templates, enhance contributing guidelines, and update README
- Add MIT license files and update package.json licenses to MIT
- Enhance README with detailed features and demo recordings for Pkg Guard
- Add versioning system with version.yml and set-version script
- Update JetBrains plugin integration and improve project trust handling

[Unreleased]: https://github.com/albiummid/pkg-guard/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/albiummid/pkg-guard/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/albiummid/pkg-guard/releases/tag/v0.1.2
