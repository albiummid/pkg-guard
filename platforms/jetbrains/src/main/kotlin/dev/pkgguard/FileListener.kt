package dev.pkgguard

import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileDeleteEvent
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.openapi.vfs.newvfs.events.VFileMoveEvent
import com.intellij.openapi.vfs.newvfs.events.VFilePropertyChangeEvent

/** package.json and every lockfile the scanner or the package managers read or write. */
private val WATCHED = setOf("package.json", "yarn.lock", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "bun.lock", "bun.lockb")

/** A lockfile or package.json changed on disk (an install, a git checkout…): scan the project it belongs to again. */
class PkgGuardFileListener : BulkFileListener {
    /** A deleted, moved or renamed file still has its old path before the change is applied: forget its import state now. */
    override fun before(events: List<VFileEvent>) {
        val gone = events.filter { it is VFileDeleteEvent || it is VFileMoveEvent || (it is VFilePropertyChangeEvent && it.isRename) }.map { it.path }
        if (gone.isEmpty()) return
        for (p in ProjectManager.getInstance().openProjects) if (!p.isDisposed) p.service<PkgGuardService>().forgetImportStates(gone)
    }

    override fun after(events: List<VFileEvent>) {
        val changed = events.filter { it.path.substringAfterLast('/') in WATCHED && !it.path.contains("/node_modules/") }
        if (changed.isEmpty()) return
        for (p in ProjectManager.getInstance().openProjects) {
            if (!p.isDisposed && changed.any { belongsTo(p, it) }) p.service<PkgGuardService>().scheduleRefresh()
        }
    }

    private fun belongsTo(project: Project, event: VFileEvent): Boolean {
        val base = project.basePath?.replace('\\', '/')
        if (base != null && (event.path == base || event.path.startsWith("$base/"))) return true
        // a content root outside the project folder (a monorepo package opened as a module)
        val file = event.file ?: return false
        return ProjectFileIndex.getInstance(project).isInContent(file)
    }
}
