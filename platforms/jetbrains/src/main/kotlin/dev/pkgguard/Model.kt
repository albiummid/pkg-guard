package dev.pkgguard

// JSON shapes of the Node sidecar (core/src/server/server.ts). Optional fields are nullable because Gson leaves missing ones null.

data class Entry(
    val name: String,
    val range: String,
    val section: String,
    val line: Int,
    val nameStart: Int,
    val end: Int,
    val versionStart: Int,
    val versionEnd: Int,
)

data class Fix(
    val type: String, // setVersion | addOverride | ignoreAdvisory | ignorePackage | install
    val title: String,
    val range: String? = null,
    val major: Boolean? = null,
    val section: String? = null,
    val name: String? = null,
    val id: String? = null,
)

data class Finding(
    val kind: String, // vuln | transitive | outdated | deprecated | stale | unsynced
    val entry: Entry,
    val level: String, // error | warning | info
    val message: String,
    val code: String? = null,
    val url: String? = null,
    val inline: String,
    val fixes: List<Fix> = emptyList(),
)

/** A bare package specifier in a JS/TS import / require; columns of the quoted string on its line. */
data class ImportRef(val name: String, val line: Int, val start: Int, val end: Int)

data class ImportFinding(
    val ref: ImportRef,
    val level: String, // error | warning | info
    val message: String,
    val inline: String,
    val code: String? = null,
    val url: String? = null,
)

data class Pm(val name: String, val installCmd: String, val overrideSection: String, val root: String? = null)

data class VersionInfo(val latest: String? = null, val versions: List<String> = emptyList(), val deprecated: Map<String, String> = emptyMap())

data class Bump(val patch: String? = null, val minor: String? = null, val major: String? = null)

data class ScanResponse(
    val entries: List<Entry>,
    val installed: Map<String, String>,
    val findings: List<Finding>,
    val info: Map<String, VersionInfo>,
    val bumps: Map<String, Bump>,
    val lock: String,
    val pm: Pm,
    val source: String,
    val notes: List<String>,
)

data class TextEdit(val startLine: Int, val startChar: Int, val endLine: Int, val endChar: Int, val newText: String)

/** `type` is edit | setting | install. */
data class FixEffect(val type: String, val edits: List<TextEdit>? = null, val key: String? = null, val value: String? = null)

data class Issue(val level: String, val text: String)

data class CompanionUpdate(val name: String, val from: String, val to: String, val reason: String)

data class CompatResponse(val issues: List<Issue>, val companions: List<CompanionUpdate>, val text: String)

/** Only the Markdown is used here; the structured `report` the sidecar also returns is ignored. */
data class UpgradeReportResponse(val markdown: String)

data class ChangelogResponse(val source: String? = null, val markdown: String? = null, val url: String? = null)

data class RepoUrl(val url: String? = null, val npm: String)

data class RangeUpdate(val name: String, val version: String, val section: String? = null)
