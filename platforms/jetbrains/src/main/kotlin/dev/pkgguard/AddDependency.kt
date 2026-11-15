package dev.pkgguard

import com.intellij.notification.NotificationType
import com.intellij.openapi.components.service
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile

/** The "Add dependency…" action of a project in the tool window. Call from the EDT. */
object AddDependency {
    val SECTIONS = arrayOf("dependencies", "devDependencies")

    /** The range written for a new dependency: a caret on the newest stable version, like the VS Code flow. */
    fun rangeFor(latest: String) = "^$latest"

    /** The registry lookup either answered (`latest` is null for an unknown package) or failed (network, registry error). */
    private sealed class Lookup {
        class Done(val latest: String?) : Lookup()
        class Failed(val reason: String) : Lookup()
    }

    fun run(project: Project, file: VirtualFile, pm: Pm?) {
        val svc = project.service<PkgGuardService>()
        val name = Messages.showInputDialog(project, "Package to add", "Pkg Guard: Add Dependency", null, "", null)?.trim()
        if (name.isNullOrEmpty()) return
        val registry = svc.settings.state.registry
        val lookup = withModalProgress(project, "Looking up $name…") {
            try {
                Lookup.Done(svc.sidecar.call<VersionsResponse?>("versions", mapOf("name" to name, "registry" to registry, "pkgFile" to file.path, "trusted" to ProjectTrust.isTrusted(project)))?.latest)
            } catch (e: ProcessCanceledException) {
                throw e
            } catch (e: Exception) {
                Lookup.Failed(e.message ?: e.toString())
            }
        } ?: return // cancelled
        val latest = when (lookup) {
            is Lookup.Failed -> return notify(project, "Could not look up \"$name\": ${lookup.reason}", NotificationType.ERROR)
            is Lookup.Done -> lookup.latest ?: return notify(project, "Package \"$name\" was not found in the registry.", NotificationType.ERROR)
        }
        val range = rangeFor(latest)
        val pick = Messages.showDialog(project, "Add $name@$range to…", "Pkg Guard: Add Dependency", SECTIONS, 0, Messages.getQuestionIcon())
        if (pick < 0) return
        val edits = withModalProgress(project, "Pkg Guard") {
            svc.sidecar.call<List<TextEdit>>("addDependencyEdits", mapOf("text" to svc.textOf(file), "section" to SECTIONS[pick], "name" to name, "range" to range))
        }.orEmpty()
        if (edits.isEmpty()) return notify(project, "Nothing to add to ${file.name}.", NotificationType.WARNING)
        applyEdits(project, file, edits) // one undoable command
        Installer.offer(project, file, pm) // saves the file first, then offers the install
    }
}
