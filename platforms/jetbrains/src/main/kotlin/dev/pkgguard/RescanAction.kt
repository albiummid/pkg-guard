package dev.pkgguard

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.components.service
import com.intellij.openapi.project.DumbAware

/** Re-scan from Find Action, the Tools menu and the editor popup of a package.json: same as the tool window Refresh. */
class RescanAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val project = e.project
        // in the editor popup only a package.json gets the entry; Find Action and the Tools menu always do
        val hidden = e.place == ActionPlaces.EDITOR_POPUP && e.getData(CommonDataKeys.VIRTUAL_FILE)?.name != "package.json"
        e.presentation.isEnabledAndVisible = project != null && !hidden
    }

    override fun actionPerformed(e: AnActionEvent) {
        e.project?.service<PkgGuardService>()?.refreshAll(clearCaches = true)
    }
}
