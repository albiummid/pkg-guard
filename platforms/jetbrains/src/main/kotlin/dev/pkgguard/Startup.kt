package dev.pkgguard

import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

/** Starts the periodic re-scan when a project opens. */
class PkgGuardStartup : ProjectActivity {
    override suspend fun execute(project: Project) {
        project.service<PkgGuardService>().schedulePeriodicRefresh()
    }
}
