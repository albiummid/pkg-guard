package dev.pkgguard

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.CapturingProcessHandler
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.SystemInfo
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiDocumentManager

/** Runs `block` on a pooled thread behind a modal progress dialog and returns its result (null when cancelled or failed). */
fun <T> withModalProgress(project: Project, title: String, block: () -> T): T? = try {
    ProgressManager.getInstance().runProcessWithProgressSynchronously<T, Exception>({ block() }, title, true, project)
} catch (e: ProcessCanceledException) {
    null // the user pressed Cancel
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

/** Writes the editor's unsaved text of `file` to disk, so a command that reads the file from disk (an install) sees it. */
fun saveDocument(file: VirtualFile) {
    ApplicationManager.getApplication().invokeAndWait {
        val docs = FileDocumentManager.getInstance()
        docs.getCachedDocument(file)?.let { docs.saveDocument(it) }
    }
}

object Fixer {
    fun apply(project: Project, file: VirtualFile, entry: Entry, fix: Fix) {
        val svc = project.service<PkgGuardService>()
        val effect = withModalProgress(project, "Pkg Guard") {
            svc.sidecar.call<FixEffect>("fixEffect", mapOf("text" to svc.textOf(file), "pkgFile" to file.path, "entry" to entry, "fix" to fix))
        } ?: return
        if (effect.type == "setting") {
            val s = svc.settings.state
            val list = if (effect.key == "ignoredAdvisories") s.ignoredAdvisories else s.ignoredPackages
            effect.value?.let { if (it !in list) list.add(it) }
            svc.refreshAll(clearCaches = false)
            return
        }
        if (effect.type == "install") {
            svc.states[file.path]?.pm?.let { Installer.install(project, file, it) }
            return
        }
        val edits = effect.edits.orEmpty()
        val target = effect.file?.let { LocalFileSystem.getInstance().refreshAndFindFileByPath(it) } ?: file
        if (effect.file != null && target === file) return notify(project, "Could not find ${effect.file}, where \"${fix.title}\" is written.", NotificationType.ERROR)
        if (effect.file != null && FileDocumentManager.getInstance().isFileModified(target)) {
            return notify(project, "Save ${target.name} first: \"${fix.title}\" is written there.", NotificationType.WARNING)
        }
        // The edit positions were computed for the text that was scanned: refuse if the line changed since, rather than editing the wrong text.
        if (effect.file == null && fix.type == "setVersion" && !stillMatches(file, entry)) {
            return notify(project, "package.json changed since it was scanned. Wait for the re-scan and try again.", NotificationType.WARNING)
        }
        applyEdits(project, target, edits)
        if (target !== file) saveDocument(target) // a pin lives in the workspace root's package.json; the install must see it
        Installer.offer(project, file, svc.states[file.path]?.pm)
    }

    /** Runs on the EDT (the intention action), where the open document can be read directly. */
    private fun stillMatches(file: VirtualFile, entry: Entry): Boolean {
        val text = FileDocumentManager.getInstance().getDocument(file)?.text ?: return false
        val line = text.lines().getOrNull(entry.line) ?: return false
        return line.getOrNull(entry.versionEnd - 1) != null && line.substring(entry.versionStart, entry.versionEnd) == entry.range
    }
}

object Installer {
    /**
     * Saves `file` first, whatever the setting, trust state or package manager: an install reads package.json from disk, and an
     * edit must not stay unsaved because no install runs. Then honours `installAfterFix` (ask / auto / never); never installs in an
     * untrusted project or when no package manager is known.
     */
    fun offer(project: Project, file: VirtualFile, pm: Pm?) {
        saveDocument(file)
        if (pm == null) return
        val mode = project.service<PkgGuardSettings>().state.installAfterFix
        if (mode == "never" || !ProjectTrust.isTrusted(project)) return
        ApplicationManager.getApplication().invokeLater {
            if (mode == "auto" || Messages.showYesNoDialog(project, "Run `${pm.installCmd}` now?", "Pkg Guard", Messages.getQuestionIcon()) == Messages.YES) install(project, file, pm)
        }
    }

    /** Saves `file` first: the install reads package.json from disk, and an Update or Pin only changed the editor's copy. */
    fun install(project: Project, file: VirtualFile, pm: Pm) = run(project, pm.root ?: file.parent.path, pm.installCmd, file)

    private val SAFE_SCRIPT = Regex("[A-Za-z0-9:._@/+-]+")

    /**
     * Runs `<pm> run <script>`. The script name comes from package.json and the command goes through the shell, so only names made of
     * plain characters are run; anything else (`;`, `&`, quotes, spaces…) is left for the user to run from a terminal.
     */
    fun runScript(project: Project, dir: String, pm: String, script: String) {
        if (!SAFE_SCRIPT.matches(script)) {
            return notify(project, "The script name \"$script\" has characters Pkg Guard does not pass to a shell. Run it from a terminal.", NotificationType.WARNING)
        }
        run(project, dir, "$pm run $script")
    }

    /** Runs `command` in `dir` in the background. `save` is written to disk first when it has unsaved changes. */
    fun run(project: Project, dir: String, command: String, save: VirtualFile? = null) {
        if (!ProjectTrust.isTrusted(project)) return notify(project, "Trust the project to run `$command`.", NotificationType.WARNING)
        save?.let(::saveDocument)
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
