package dev.pkgguard

/** The versions whose release notes to read (after [from], up to and including [to]) and the viewer title. */
data class NotesRange(val from: String, val to: String, val title: String)

/**
 * Same ranges as the VS Code version-level changelog: "installed to this" reads everything after the installed version,
 * "this version only" reads the one release. [newer] is the stable versions above [installed], newest first.
 */
fun versionNotes(name: String, installed: String, newer: List<String>, version: String, thisOnly: Boolean): NotesRange =
    if (thisOnly) NotesRange(newer.getOrNull(newer.indexOf(version) + 1) ?: installed, version, "$name $version")
    else NotesRange(installed, version, "$name $installed → $version")
