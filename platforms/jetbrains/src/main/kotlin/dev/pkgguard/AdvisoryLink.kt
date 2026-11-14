package dev.pkgguard

import com.intellij.codeInsight.intention.IntentionAction
import com.intellij.codeInsight.intention.preview.IntentionPreviewInfo
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiFile
import java.net.URI

/** The Advisory link when it is a well-formed http(s) URL, else null (same rule as VS Code: nothing else is ever opened). */
fun advisoryLink(url: String?): String? {
    val s = url?.trim().orEmpty()
    val uri = try { URI(s) } catch (_: Exception) { return null }
    val scheme = uri.scheme?.lowercase()
    return if ((scheme == "http" || scheme == "https") && !uri.host.isNullOrEmpty()) s else null
}

/** Tooltip text of a vulnerability annotation: the Advisory id (when known) before the message (plain text, the platform does not parse it as HTML). */
fun advisoryTooltip(id: String?, message: String): String {
    return if (id.isNullOrBlank()) message else "$id: $message"
}

/** Alt+Enter "Open advisory" action; only built for a link that passed [advisoryLink]. */
class OpenAdvisoryIntention(private val id: String?, private val link: String) : IntentionAction {
    override fun getText(): String = if (id.isNullOrBlank()) "Open advisory" else "Open advisory $id"
    override fun getFamilyName(): String = "Pkg Guard"
    override fun isAvailable(project: Project, editor: Editor?, file: PsiFile?): Boolean = true
    override fun startInWriteAction(): Boolean = false
    override fun generatePreview(project: Project, editor: Editor, file: PsiFile): IntentionPreviewInfo = IntentionPreviewInfo.EMPTY
    override fun invoke(project: Project, editor: Editor?, file: PsiFile?) {
        advisoryLink(link)?.let { BrowserUtil.browse(it) }
    }
}
