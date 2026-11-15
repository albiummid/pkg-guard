package dev.pkgguard

import com.intellij.notification.NotificationType
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.VirtualFile

/** Remove-dependency action of the tool window: confirm, edit as one undoable command, save, then offer the install. */
object RemoveDependency {
    fun confirmText(name: String) = "Remove $name from package.json?"

    fun run(project: Project, file: VirtualFile, name: String) {
        if (Messages.showYesNoDialog(project, confirmText(name), "Pkg Guard", "Remove", "Cancel", Messages.getWarningIcon()) != Messages.YES) return
        val svc = project.service<PkgGuardService>()
        val edits = withModalProgress(project, "Pkg Guard") {
            svc.sidecar.call<List<TextEdit>>("removeDependencyEdits", RemoveDependencyParams(svc.textOf(file), name))
        } ?: return
        if (edits.isEmpty()) return notify(project, "$name is not declared in ${file.name}.", NotificationType.WARNING)
        applyEdits(project, file, edits) // one whole-document replacement, so one undo step
        Installer.offer(project, file, svc.states[file.path]?.pm) // saves the file first, then offers the install
    }
}
