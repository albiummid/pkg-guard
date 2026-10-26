package dev.pkgguard

import com.intellij.ide.trustedProjects.TrustedProjects
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.COLUMNS_LARGE
import com.intellij.ui.dsl.builder.bindItem
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.columns
import com.intellij.ui.dsl.builder.panel

@Service(Service.Level.PROJECT)
@State(name = "PkgGuardSettings", storages = [Storage("pkgGuard.xml")])
class PkgGuardSettings : PersistentStateComponent<PkgGuardSettings.State> {
    // Mirrors the VS Code `pkgGuard.*` options.
    class State {
        var nodePath: String = "node"
        var enableVulnerabilities: Boolean = true
        var checkTransitive: Boolean = true
        var enableOutdated: Boolean = true
        var showMajorUpdates: Boolean = true
        var minSeverity: String = "low"
        var auditFallback: Boolean = true
        var installAfterFix: String = "ask"
        var registry: String = "https://registry.npmjs.org"
        var ignoredAdvisories: MutableList<String> = mutableListOf()
        var ignoredPackages: MutableList<String> = mutableListOf()
    }

    private var state = State()
    override fun getState(): State = state
    override fun loadState(s: State) {
        state = s
    }

    /** The `Settings` object of src/scan.ts. `yarn audit` / `npm audit` run code from the project, so they need a trusted project. */
    fun forSidecar(project: Project): Map<String, Any> = mapOf(
        "enableVulnerabilities" to state.enableVulnerabilities,
        "checkTransitive" to state.checkTransitive,
        "enableOutdated" to state.enableOutdated,
        "showMajorUpdates" to state.showMajorUpdates,
        "minSeverity" to state.minSeverity,
        "auditFallback" to (state.auditFallback && TrustedProjects.isProjectTrusted(project)),
        "registry" to state.registry,
        "ignoredAdvisories" to state.ignoredAdvisories,
        "ignoredPackages" to state.ignoredPackages,
    )
}

class PkgGuardConfigurable(private val project: Project) : BoundConfigurable("Pkg Guard") {
    private fun csv(list: MutableList<String>, set: (MutableList<String>) -> Unit) =
        Pair({ list.joinToString(", ") }, { text: String -> set(text.split(',').map { it.trim() }.filter { it.isNotEmpty() }.toMutableList()) })

    override fun createPanel(): DialogPanel {
        val s = project.service<PkgGuardSettings>().state
        val advisories = csv(s.ignoredAdvisories) { s.ignoredAdvisories = it }
        val packages = csv(s.ignoredPackages) { s.ignoredPackages = it }
        return panel {
            row("Node executable:") {
                textField().bindText(s::nodePath).columns(COLUMNS_LARGE).comment("Node.js 18 or newer. Runs the scanner bundled with the plugin.")
            }
            group("Checks") {
                row { checkBox("Report known vulnerabilities (OSV.dev)").bindSelected(s::enableVulnerabilities) }
                row { checkBox("Include transitive dependencies (yarn.lock v1 / package-lock.json)").bindSelected(s::checkTransitive) }
                row { checkBox("Suggest newer versions from the registry").bindSelected(s::enableOutdated) }
                row { checkBox("Also suggest updates that cross a major version").bindSelected(s::showMajorUpdates) }
                row { checkBox("Fall back to yarn / npm audit when OSV.dev is unreachable (trusted projects only)").bindSelected(s::auditFallback) }
                row("Hide vulnerabilities below:") {
                    comboBox(listOf("low", "moderate", "high", "critical")).bindItem({ s.minSeverity }, { s.minSeverity = it ?: "low" })
                }
            }
            group("Updates") {
                row("Run install after an update:") {
                    comboBox(listOf("ask", "auto", "never")).bindItem({ s.installAfterFix }, { s.installAfterFix = it ?: "ask" })
                }
                row("Registry:") { textField().bindText(s::registry).columns(COLUMNS_LARGE) }
            }
            group("Ignore") {
                row("Advisories:") { textField().bindText(advisories.first, advisories.second).columns(COLUMNS_LARGE).comment("Comma separated GHSA-… / CVE-… ids") }
                row("Packages:") { textField().bindText(packages.first, packages.second).columns(COLUMNS_LARGE).comment("Comma separated; no update suggestions for these") }
            }
        }
    }

    override fun apply() {
        super.apply()
        project.service<Sidecar>().restart() // the node path may have changed
        project.service<PkgGuardService>().refreshAll(clearCaches = false)
    }
}
