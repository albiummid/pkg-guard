# Changelog

All notable changes to Pkg Guard are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/). Add entries under **Unreleased** as you go; `yarn cli release`
moves them under the new version. If Unreleased is empty at release time, entries are generated from the commit messages.

## [Unreleased]

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
