package dev.pkgguard

/** True for the note the scan writes when no vulnerability check could be made (OSV.dev and the audit fallback both failed). */
fun isCheckFailure(note: String): Boolean = note.startsWith("vulnerability check failed")

/** Names the data source of the last scan as the tool window shows it. */
fun sourceLabel(source: String): String = when (source) {
    "osv" -> "OSV.dev"
    "audit" -> "audit fallback"
    else -> "none"
}
