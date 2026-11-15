package dev.pkgguard

import com.intellij.notification.NotificationType
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile

data class PinParams(val section: String, val name: String, val range: String)

/** Every vulnerability Fix of one scan: Updates for direct dependencies, Pins for Transitive vulnerabilities. */
class FixPlan(val updates: List<RangeUpdate>, val pins: List<PinParams>) {
    val isEmpty get() = updates.isEmpty() && pins.isEmpty()

    /** The confirmation text. Pins go to the workspace root's package.json, so say which file that is. */
    fun describe(pinFile: String): String {
        val lines = updates.map { "• update ${it.name} → ${it.version} (${it.section})" } + pins.map { "• pin ${it.name} ${it.range} (${it.section})" }
        val note = if (pins.isEmpty()) "" else "\n\nPins are written to $pinFile (the manifest the package manager reads)."
        return lines.joinToString("\n") + note
    }

    companion object {
        /** The operators the core writes in front of a fixed version (prefixOf); rangeEdits puts the manifest's own operator back, so a >= range keeps it. */
        private val OPERATOR = Regex("^(\\^|~|>=)")

        fun of(findings: List<Finding>): FixPlan {
            val updates = LinkedHashMap<Pair<String, String>, RangeUpdate>() // a package declared in two sections is updated in both
            val pins = LinkedHashMap<String, PinParams>()
            for (f in findings) for (fx in f.fixes) {
                if (fx.type == "setVersion" && f.kind == "vuln" && fx.range != null) {
                    updates[f.entry.section to f.entry.name] = RangeUpdate(f.entry.name, fx.range.replace(OPERATOR, ""), f.entry.section)
                }
                if (fx.type == "addOverride" && f.kind == "transitive" && fx.name != null && fx.range != null && fx.section != null) {
                    pins[fx.name] = PinParams(fx.section, fx.name, fx.range)
                }
            }
            return FixPlan(updates.values.toList(), pins.values.toList())
        }
    }
}

/** The project action "Fix vulnerabilities". Call from the EDT. */
object FixVulns {
    fun run(project: Project, file: VirtualFile) {
        val svc = project.service<PkgGuardService>()
        // planned against the editor's current text, not a cached scan of older text (its edits would hit moved lines);
        // the scanner reuses the stored result when the text is unchanged
        val st = withModalProgress(project, "Scanning ${file.name}…") { svc.scan(file) } ?: return
        val plan = FixPlan.of(st.findings)
        if (plan.isEmpty) return notify(project, "No fixable vulnerabilities found.")

        // Pins only count in the workspace root's package.json. Resolve and check it before anything changes,
        // so a root with unsaved changes cannot leave the fix half applied.
        var pinFile = file
        if (plan.pins.isNotEmpty()) {
            val effect = pinsEffect(project, file, plan.pins) ?: return
            effect.file?.let { path ->
                pinFile = LocalFileSystem.getInstance().refreshAndFindFileByPath(path)
                    ?: return notify(project, "Could not find $path, where the pins are written.", NotificationType.ERROR)
                if (FileDocumentManager.getInstance().isFileModified(pinFile)) {
                    return notify(project, "Save ${pinFile.name} first: the pins are written there.", NotificationType.WARNING)
                }
            }
        }
        val where = if (pinFile === file) file.name else pinFile.path
        val n = plan.updates.size + plan.pins.size
        val ok = Messages.showOkCancelDialog(project, plan.describe(where), "Fix $n vulnerable ${if (n == 1) "package" else "packages"}?", "Fix", "Cancel", Messages.getWarningIcon())
        if (ok != Messages.OK) return

        if (plan.updates.isNotEmpty()) {
            val edits = withModalProgress(project, "Pkg Guard") {
                svc.sidecar.call<List<TextEdit>>("rangeEdits", mapOf("text" to svc.textOf(file), "updates" to plan.updates))
            } ?: return
            applyEdits(project, file, edits)
        }
        if (plan.pins.isNotEmpty()) {
            // computed again: when the pins go to this very file, the Updates just changed its text
            val effect = pinsEffect(project, file, plan.pins) ?: return
            applyEdits(project, pinFile, effect.edits.orEmpty())
            if (pinFile !== file) saveDocument(pinFile) // the install must see the pins on disk
        }
        // the install is offered once; it saves `file` first
        Installer.offer(project, file, st.pm)
    }

    private fun pinsEffect(project: Project, file: VirtualFile, pins: List<PinParams>): FixEffect? {
        val svc = project.service<PkgGuardService>()
        return withModalProgress(project, "Pkg Guard") {
            svc.sidecar.call<FixEffect>("pinsEffect", mapOf("text" to svc.textOf(file), "pkgFile" to file.path, "pins" to pins))
        }
    }
}
