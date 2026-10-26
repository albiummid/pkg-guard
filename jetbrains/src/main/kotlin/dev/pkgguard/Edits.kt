package dev.pkgguard

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.CapturingProcessHandler
import com.intellij.ide.trustedProjects.TrustedProjects
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.SystemInfo
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiDocumentManager

/** Runs `block` on a pooled thread behind a modal progress dialog and returns its result (null when cancelled or failed). */
fun <T> withModalProgress(project: Project, title: String, block: () -> T): T? = try {
    ProgressManager.getInstance().runProcessWithProgressSynchronously<T, Exception>({ block() }, title, true, project)
} catch (e: Exception) {
    notify(project, e.message ?: e.toString(), NotificationType.ERROR)
    null
}

/** Applies sidecar edits (0-based line / column) to the document as one undoable command. */
fun applyEdits(project: Project, file: VirtualFile, edits: List<TextEdit>) {
    val doc = FileDocumentManager.getInstance().getDocument(file) ?: return
    WriteCommandAction.runWriteCommandAction(project, "Pkg Guard", null, {
        // back to front, so earlier offsets stay valid
        for (e in edits.sortedWith(compareByDescending<TextEdit> { it.startLine }.thenByDescending { it.startChar })) {
            val start = doc.getLineStartOffset(e.startLine) + e.startChar
            val end = (doc.getLineStartOffset(e.endLine) + e.endChar).coerceAtMost(doc.textLength)
            doc.replaceString(start, end, e.newText)
        }
        PsiDocumentManager.getInstance(project).commitDocument(doc)
    })
}

object Fixer {
    fun apply(project: Project, file: VirtualFile, entry: Entry, fix: Fix) {
        val svc = project.service<PkgGuardService>()
        val effect = withModalProgress(project, "Pkg Guard") {
            svc.sidecar.call<FixEffect>("fixEffect", mapOf("text" to svc.textOf(file), "entry" to entry, "fix" to fix))
        } ?: return
        if (effect.type == "setting") {
            val s = svc.settings.state
            val list = if (effect.key == "ignoredAdvisories") s.ignoredAdvisories else s.ignoredPackages
            effect.value?.let { if (it !in list) list.add(it) }
            svc.refreshAll(clearCaches = false)
            return
        }
        applyEdits(project, file, effect.edits.orEmpty())
        svc.states[file.path]?.pm?.let { Installer.offer(project, file, it) }
    }
}

object Installer {
    /** Honours `installAfterFix` (ask / auto / never) and never installs in an untrusted project. */
    fun offer(project: Project, file: VirtualFile, pm: Pm) {
        val mode = project.service<PkgGuardSettings>().state.installAfterFix
        if (mode == "never" || !TrustedProjects.isProjectTrusted(project)) return
        ApplicationManager.getApplication().invokeLater {
            if (mode == "auto" || Messages.showYesNoDialog(project, "Run `${pm.installCmd}` now?", "Pkg Guard", Messages.getQuestionIcon()) == Messages.YES) install(project, file, pm)
        }
    }

    fun install(project: Project, file: VirtualFile, pm: Pm) = run(project, pm.root ?: file.parent.path, pm.installCmd)

    fun run(project: Project, dir: String, command: String) {
        if (!TrustedProjects.isProjectTrusted(project)) return notify(project, "Trust the project to run `$command`.", NotificationType.WARNING)
        object : Task.Backgroundable(project, "Running $command", true) {
            override fun run(indicator: ProgressIndicator) {
                // npm / yarn / pnpm are .cmd shims on Windows, so go through the shell
                val line = if (SystemInfo.isWindows) GeneralCommandLine("cmd.exe", "/c", command) else GeneralCommandLine("sh", "-c", command)
                val out = CapturingProcessHandler(line.withWorkDirectory(dir).withParentEnvironmentType(GeneralCommandLine.ParentEnvironmentType.CONSOLE)).runProcessWithProgressIndicator(indicator)
                if (out.exitCode == 0) notify(project, "`$command` finished.")
                else notify(project, "`$command` failed (exit ${out.exitCode}):\n" + out.stderr.lines().takeLast(8).joinToString("\n"), NotificationType.ERROR)
                project.service<PkgGuardService>().scheduleRefresh()
            }
        }.queue()
    }
}
