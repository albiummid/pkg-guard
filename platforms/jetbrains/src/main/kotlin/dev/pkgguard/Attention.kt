package dev.pkgguard

/** Finding kinds that need action: a vulnerability, a Transitive vulnerability, a deprecation, an Out-of-sync install. */
private val ATTENTION_KINDS = setOf("vuln", "transitive", "deprecated", "unsynced")

/** The dependencies of a project that need attention, in declaration order. Updates and Stale ranges alone do not count. */
fun needsAttention(entries: List<Entry>, findings: List<Finding>): List<Entry> {
    val flagged = findings.filter { it.kind in ATTENTION_KINDS }.map { it.entry.section to it.entry.name }.toSet()
    return entries.filter { (it.section to it.name) in flagged }
}
