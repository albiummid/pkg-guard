package dev.pkgguard

import com.intellij.ide.BrowserUtil
import com.intellij.notification.NotificationType
import com.intellij.openapi.components.service
import com.intellij.openapi.fileChooser.FileChooserFactory
import com.intellij.openapi.fileChooser.FileSaverDescriptor
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import java.awt.Dimension
import java.awt.datatransfer.StringSelection
import java.awt.event.ActionEvent
import javax.swing.JComponent

/** Read-only text in a dialog: compatibility reports and release notes. */
fun showText(project: Project, title: String, text: String) {
    object : DialogWrapper(project, true) {
        init {
            this.title = title
            setOKButtonText("Close")
            init()
        }

        override fun createCenterPanel(): JComponent =
            JBScrollPane(JBTextArea(text).apply { isEditable = false; lineWrap = true; wrapStyleWord = true; caretPosition = 0 }).apply { preferredSize = Dimension(720, 460) }

        override fun createActions() = arrayOf(okAction)
    }.show()
}

/** The upgrade report as text, with Copy and Save as… next to Close. */
private fun showReport(project: Project, title: String, markdown: String) {
    object : DialogWrapper(project, true) {
        init {
            this.title = title
            setOKButtonText("Close")
            init()
        }

        override fun createCenterPanel(): JComponent =
            JBScrollPane(JBTextArea(markdown).apply { isEditable = false; caretPosition = 0 }).apply { preferredSize = Dimension(900, 560) }

        override fun createActions() = arrayOf(
            object : DialogWrapperAction("Copy") {
                override fun doAction(e: ActionEvent?) = CopyPasteManager.getInstance().setContents(StringSelection(markdown))
            },
            object : DialogWrapperAction("Save as…") {
                override fun doAction(e: ActionEvent?) {
                    val target = FileChooserFactory.getInstance()
                        .createSaveFileDialog(FileSaverDescriptor("Save Upgrade Report", "Markdown file", "md"), project)
                        .save(null as VirtualFile?, "UPGRADE_REPORT.md") ?: return
                    target.file.writeText(markdown)
                    notify(project, "Saved ${target.file.name}.")
                }
            },
            okAction,
        )
    }.show()
}

/** Update (with a peer / engines compatibility check) and the other dependency actions of the tool window. Call from the EDT. */
object UpdateFlow {
    fun pickVersion(project: Project, dep: Entry, st: ScanResponse): String? {
        val versions = st.info[dep.name]?.versions.orEmpty()
        if (versions.isEmpty()) return notify(project, "No versions known for ${dep.name}.", NotificationType.WARNING).let { null }
        val installed = st.installed[dep.name]
        val labels = versions.map { v -> if (v == installed) "$v  (installed)" else v }.toTypedArray()
        val pick = Messages.showEditableChooseDialog("Version of ${dep.name} (installed ${installed ?: "?"})", "Pkg Guard", null, labels, labels.first(), null)
        return pick?.substringBefore(' ')
    }

    fun update(project: Project, file: VirtualFile, dep: Entry, target: String?, onlyReport: Boolean = false) {
        val svc = project.service<PkgGuardService>()
        val st = svc.states[file.path] ?: return
        val installed = st.installed[dep.name]
        val to = target ?: pickVersion(project, dep, st) ?: return
        if (to == installed) return notify(project, "${dep.name} is already at $to.")

        val report = withModalProgress(project, "Checking ${dep.name}@$to compatibility…") {
            svc.sidecar.call<CompatResponse>(
                "compat",
                mapOf("text" to svc.textOf(file), "pkgFile" to file.path, "name" to dep.name, "target" to to, "registry" to svc.settings.state.registry, "installed" to st.installed),
            )
        } ?: return
        if (onlyReport) return showText(project, "${dep.name} ${installed ?: "?"} → $to", report.text)

        val updates = mutableListOf(RangeUpdate(dep.name, to, dep.section))
        if (report.issues.any { it.level == "error" || it.level == "warning" }) {
            val hasError = report.issues.any { it.level == "error" }
            val n = report.companions.size
            val companions = if (n > 0) "Update + $n companion${if (n > 1) "s" else ""}" else null
            val buttons = listOfNotNull(companions, if (hasError) "Update anyway" else "Update", "View report", "Cancel")
            val pick = buttons.getOrNull(Messages.showDialog(project, report.text, "${dep.name} ${installed ?: "?"} → $to", buttons.toTypedArray(), 0, Messages.getWarningIcon()))
            when (pick) {
                null, "Cancel" -> return
                "View report" -> return showText(project, "${dep.name} ${installed ?: "?"} → $to", report.text)
                companions -> report.companions.forEach { updates.add(RangeUpdate(it.name, it.to)) }
            }
        }
        applyRanges(project, file, updates, st.pm)
    }

    private fun applyRanges(project: Project, file: VirtualFile, updates: List<RangeUpdate>, pm: Pm) {
        val svc = project.service<PkgGuardService>()
        val edits = withModalProgress(project, "Pkg Guard") {
            svc.sidecar.call<List<TextEdit>>("rangeEdits", mapOf("text" to svc.textOf(file), "updates" to updates))
        }.orEmpty()
        if (edits.isEmpty()) return notify(project, "Nothing to update in ${file.name}.", NotificationType.WARNING)
        applyEdits(project, file, edits)
        Installer.offer(project, file, pm)
    }

    /** Bulk update of every dependency to its newest patch / minor / major. */
    fun updateAll(project: Project, file: VirtualFile, level: String) {
        val st = project.service<PkgGuardService>().states[file.path] ?: return
        val updates = mutableListOf<RangeUpdate>()
        val lines = mutableListOf<String>()
        for (e in st.entries.distinctBy { it.name }) {
            val installed = st.installed[e.name] ?: continue
            val t = st.bumps[e.name] ?: continue
            val to = when (level) {
                "patch" -> t.patch
                "minor" -> t.minor ?: t.patch
                else -> t.major ?: t.minor ?: t.patch
            } ?: continue
            updates.add(RangeUpdate(e.name, to, e.section))
            lines.add("• ${e.name}  $installed → $to")
        }
        if (updates.isEmpty()) return notify(project, "No $level updates available.")
        val warn = if (level == "major") "\n\nMajor updates can contain breaking changes. Check single packages first with \"Check compatibility\"." else ""
        val ok = Messages.showOkCancelDialog(project, lines.joinToString("\n") + warn, "Update ${updates.size} dependencies ($level)?", "Update ${updates.size}", "Cancel", Messages.getWarningIcon())
        if (ok == Messages.OK) applyRanges(project, file, updates, st.pm)
    }

    /** Every available upgrade grouped by risk (safe / caution / major), built by the sidecar. */
    fun upgradeReport(project: Project, file: VirtualFile) {
        val svc = project.service<PkgGuardService>()
        val res = withModalProgress(project, "Building upgrade report…") {
            svc.sidecar.call<UpgradeReportResponse>("upgradeReport", mapOf("text" to svc.textOf(file), "pkgFile" to file.path, "settings" to svc.settings.forSidecar(project)))
        } ?: return
        showReport(project, "Upgrade report — ${file.parent?.name ?: file.name}", res.markdown)
    }

    /** Pick one newer version (or everything up to the newest) and show its release notes. */
    fun changelog(project: Project, file: VirtualFile, dep: Entry) {
        val svc = project.service<PkgGuardService>()
        val st = svc.states[file.path] ?: return
        val installed = st.installed[dep.name]
        val registry = svc.settings.state.registry
        val newer = st.info[dep.name]?.versions.orEmpty().takeWhile { it != installed }
        if (installed == null || newer.isEmpty()) return openRepo(project, dep)
        val all = "Everything since $installed (up to ${newer.first()})"
        val pick = Messages.showEditableChooseDialog("Changelog of ${dep.name} (installed $installed)", "Pkg Guard", null, (listOf(all) + newer).toTypedArray(), all, null) ?: return
        val (from, to) = if (pick == all) installed to newer.first() else (newer.getOrNull(newer.indexOf(pick) + 1) ?: installed) to pick
        val res = withModalProgress(project, "Fetching ${dep.name} release notes…") {
            svc.sidecar.call<ChangelogResponse>("changelog", mapOf("name" to dep.name, "from" to from, "to" to to, "registry" to registry))
        } ?: return
        if (res.markdown != null) showText(project, "${dep.name} $from → $to", "Source: ${res.source}\n\n${res.markdown}")
        else res.url?.let { BrowserUtil.browse(it) }
    }

    fun openRepo(project: Project, dep: Entry) {
        val svc = project.service<PkgGuardService>()
        val r = withModalProgress(project, "Pkg Guard") { svc.sidecar.call<RepoUrl>("repoUrl", mapOf("name" to dep.name, "registry" to svc.settings.state.registry)) } ?: return
        val url = r.url ?: return notify(project, "${dep.name} does not declare a repository.", NotificationType.WARNING)
        BrowserUtil.browse(url)
    }
}
