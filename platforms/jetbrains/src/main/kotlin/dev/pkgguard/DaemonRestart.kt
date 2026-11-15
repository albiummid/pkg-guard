package dev.pkgguard

import com.intellij.codeInsight.daemon.DaemonCodeAnalyzer
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiFile
import java.lang.reflect.Method

/**
 * Re-runs the highlighting passes, which is how scan results reach the editor's annotations.
 *
 * `DaemonCodeAnalyzer.restart()` and `restart(PsiFile)` are deprecated from 2026.3 in favour of versions that take a reason, but those
 * do not exist on 242, the oldest build this plugin supports. A direct call to either pair would leave a deprecated or a missing
 * reference on one side of that range (and the plugin verifier reads bytecode, so even an unreachable call counts). Both pairs are
 * therefore looked up by name once, and the reason-taking one is preferred.
 */
object DaemonRestart {
    private const val REASON = "Pkg Guard scan results changed"

    private fun find(vararg params: Class<*>): Method? = try {
        DaemonCodeAnalyzer::class.java.getMethod("restart", *params)
    } catch (e: NoSuchMethodException) {
        null
    }

    private val project: Method? = find(Any::class.java) ?: find()
    private val projectTakesReason = find(Any::class.java) != null
    private val file: Method? = find(PsiFile::class.java, Any::class.java) ?: find(PsiFile::class.java)
    private val fileTakesReason = find(PsiFile::class.java, Any::class.java) != null

    fun restart(project: Project) {
        val analyzer = DaemonCodeAnalyzer.getInstance(project)
        if (projectTakesReason) this.project?.invoke(analyzer, REASON) else this.project?.invoke(analyzer)
    }

    fun restart(project: Project, file: PsiFile) {
        val analyzer = DaemonCodeAnalyzer.getInstance(project)
        if (fileTakesReason) this.file?.invoke(analyzer, file, REASON) else this.file?.invoke(analyzer, file)
    }
}
