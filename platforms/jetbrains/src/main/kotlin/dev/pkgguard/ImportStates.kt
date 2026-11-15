package dev.pkgguard

import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.vfs.VirtualFile

/** Removes the entries of [paths] and of every path below one of them. True when something was removed. */
fun dropImportStates(states: MutableMap<String, *>, paths: Collection<String>): Boolean {
    if (paths.isEmpty()) return false
    return states.keys.removeIf { key -> paths.any { key == it || key.startsWith("$it/") } }
}

/** The import state of a source file is only worth keeping while the file is open: a file that comes back is annotated again. */
class ImportStateCloseListener : FileEditorManagerListener {
    override fun fileClosed(source: FileEditorManager, file: VirtualFile) {
        // the file can still be open in another split
        if (source.isFileOpen(file)) return
        source.project.service<PkgGuardService>().forgetImportStates(listOf(file.path))
    }
}
