# Pkg Guard

Shows vulnerability warnings and update suggestions for the dependencies declared in a `package.json`, and offers safe fixes.

## Language

### Versions

**Declared range**:
The version constraint written in `package.json` for a dependency (e.g. `^1.2.0`).
_Avoid_: Version, requirement

**Installed version**:
The exact version of a dependency confirmed by the lockfile or `node_modules`.
_Avoid_: Current version, resolved version

**Floor version**:
The lowest version a Declared range permits (`^1.2.0` gives `1.2.0`), used only when no Installed version can be confirmed. A guess, so warnings based on it read "may be vulnerable".
_Avoid_: Assumed version, installed version

### Security

**Advisory**:
A published record of a security flaw in a package, with its affected versions and fixed version, identified by an ID. Sourced from OSV.dev.
_Avoid_: CVE, report

**Vulnerability**:
An Advisory that applies to one specific copy of a package (an Installed or Floor version) in the user's project. One Advisory yields one Vulnerability per affected copy.
_Avoid_: Issue, finding

**Transitive vulnerability**:
A Vulnerability in a package the user did not declare, shown on the direct dependency that pulls it in.
_Avoid_: Indirect vulnerability, nested vulnerability

### Findings

**Finding**:
A warning shown on one dependency line in `package.json`, with the Fixes and Suppressions available for it. Its kind is one of: vulnerability, Transitive vulnerability, available Update, or deprecation. One Finding groups every Vulnerability of its kind on that line.
_Avoid_: Issue, diagnostic, alert

**Severity**:
How serious a Vulnerability is: critical, high, moderate, low or unknown. Comes from the Advisory.
_Avoid_: Risk, priority

**Level**:
How a Finding or Compatibility issue is presented: error, warning or info. For a Finding, derived from the Severity of its worst Vulnerability.
_Avoid_: Severity

### Actions

**Fix**:
A one-click action that edits `package.json` so a finding goes away. Either an Update or a Pin.
_Avoid_: Patch, remediation

**Update**:
A Fix that changes a dependency's Declared range to a newer version.
_Avoid_: Upgrade, bump

**Pin**:
A Fix that forces the version of a transitive package through `resolutions` or `overrides`.
_Avoid_: Override, resolution

**Suppression**:
A one-click action that hides a finding without changing the dependency, stored in host settings. Either ignoring an Advisory or ignoring a package. Leaves the vulnerable version in place.
_Avoid_: Ignore fix, dismissal

### Compatibility

**Compatibility check**:
The pre-flight analysis of an Update to a target version, showing what else would break or change.
_Avoid_: Preflight, impact analysis

**Compatibility issue**:
One problem or notice found by a Compatibility check, at a Level of error, warning or info.
_Avoid_: Issue, conflict

**Companion update**:
An Update to a different dependency that is needed for the target version to work, offered only when a newer version of that dependency accepts the target. If none does, the result is an error-level Compatibility issue with no Companion update.
_Avoid_: Related update, dependent update
