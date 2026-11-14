package dev.pkgguard

import com.intellij.notification.NotificationType
import com.intellij.openapi.components.service
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile

/** The "Add dependency…" action of a project in the tool window. Call from the EDT. */
object AddDependency {
    val SECTIONS = arrayOf("dependencies", "devDependencies")

    /** The range written for a new dependency: a caret on the newest stable version, like the VS Code flow. */
    fun rangeFor(latest: String) = "^$latest"

    fun run(project: Project, file: VirtualFile, pm: Pm?) {
        val svc = project.service<PkgGuardService>()
        val name = Messages.showInputDialog(project, "Package to add", "Pkg Guard: Add Dependency", null, "", null)?.trim()
        if (name.isNullOrEmpty()) return
        val registry = svc.settings.state.registry
        val latest = withModalProgress(project, "Looking up $name…") {
            svc.sidecar.call<VersionsResponse?>("versions", mapOf("name" to name, "registry" to registry))
        }?.latest ?: return notify(project, "Package \"$name\" was not found in the registry.", NotificationType.ERROR)
        val range = rangeFor(latest)
        val pick = Messages.showChooseDialog("Add $name@$range to…", "Pkg Guard: Add Dependency", SECTIONS, SECTIONS.first(), null)
        if (pick < 0) return
        val edits = withModalProgress(project, "Pkg Guard") {
            svc.sidecar.call<List<TextEdit>>("addDependencyEdits", mapOf("text" to svc.textOf(file), "section" to SECTIONS[pick], "name" to name, "range" to range))
        }.orEmpty()
        if (edits.isEmpty()) return notify(project, "Nothing to add to ${file.name}.", NotificationType.WARNING)
        applyEdits(project, file, edits) // one undoable command
        // saved before the install, which reads package.json from disk
        pm?.let { Installer.offer(project, file, it) } ?: saveDocument(file)
    }
}
