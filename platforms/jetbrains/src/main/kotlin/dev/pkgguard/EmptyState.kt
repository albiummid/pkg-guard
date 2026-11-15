package dev.pkgguard

/**
 * The tool window's text when it has no tree. Only a project without any package.json gets a message, so the tree being
 * empty because a scan of existing manifests has not finished yet never shows "not found". Empty string means no message.
 */
fun emptyStateText(manifestCount: Int): String =
    if (manifestCount == 0) "No package.json found in this project. Pkg Guard needs a package.json to check dependencies; add one and it is scanned automatically." else ""
