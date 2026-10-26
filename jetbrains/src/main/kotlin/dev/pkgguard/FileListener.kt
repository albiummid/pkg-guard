package dev.pkgguard

import com.intellij.openapi.components.service
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent

private val WATCHED = setOf("package.json", "yarn.lock", "package-lock.json", "pnpm-lock.yaml")

/** A lockfile or package.json changed on disk (an install, a git checkout…): scan again. */
class PkgGuardFileListener : BulkFileListener {
    override fun after(events: List<VFileEvent>) {
        if (events.none { it.path.substringAfterLast('/') in WATCHED && !it.path.contains("/node_modules/") }) return
        for (p in ProjectManager.getInstance().openProjects) if (!p.isDisposed) p.service<PkgGuardService>().scheduleRefresh()
    }
}
