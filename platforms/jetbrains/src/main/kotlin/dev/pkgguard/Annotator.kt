package dev.pkgguard

import com.intellij.codeInsight.intention.IntentionAction
import com.intellij.codeInsight.intention.preview.IntentionPreviewInfo
import com.intellij.lang.annotation.AnnotationHolder
import com.intellij.lang.annotation.ExternalAnnotator
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiFile

fun isPackageJson(file: VirtualFile): Boolean = file.name == "package.json" && !file.path.contains("/node_modules/")

/** Vulnerability / update / deprecation findings on the dependency lines of package.json. */
class PackageJsonAnnotator : ExternalAnnotator<PackageJsonAnnotator.Input, ScanResponse>() {
    class Input(val file: VirtualFile, val text: String, val project: Project)

    override fun collectInformation(file: PsiFile): Input? {
        val vf = file.virtualFile ?: return null
        return if (isPackageJson(vf)) Input(vf, file.text, file.project) else null
    }

    override fun doAnnotate(input: Input?): ScanResponse? = input?.project?.service<PkgGuardService>()?.scanText(input.file, input.text)

    override fun apply(file: PsiFile, result: ScanResponse?, holder: AnnotationHolder) {
        result ?: return
        val doc = file.viewProvider.document ?: return
        for (f in result.findings) {
            if (f.entry.line >= doc.lineCount) continue
            val lineStart = doc.getLineStartOffset(f.entry.line)
            val end = lineStart + f.entry.end
            if (end > doc.textLength) continue
            val severity = when (f.level) {
                "error" -> HighlightSeverity.ERROR
                "warning" -> HighlightSeverity.WARNING
                else -> HighlightSeverity.WEAK_WARNING
            }
            val b = holder.newAnnotation(severity, f.message).range(TextRange(lineStart + f.entry.nameStart, end))
            if (f.kind == "outdated") b.textAttributes(com.intellij.openapi.editor.DefaultLanguageHighlighterColors.LINE_COMMENT)
            f.fixes.forEach { b.withFix(ApplyFixIntention(f, it)) }
            b.create()
        }
    }
}

/** Alt+Enter action for one `Fix` of a finding. */
class ApplyFixIntention(private val finding: Finding, private val fix: Fix) : IntentionAction {
    override fun getText(): String = fix.title
    override fun getFamilyName(): String = "Pkg Guard"
    override fun isAvailable(project: Project, editor: Editor?, file: PsiFile?): Boolean = file?.virtualFile != null
    override fun startInWriteAction(): Boolean = false

    // the default preview would run `invoke` on a copy, which would talk to the sidecar
    override fun generatePreview(project: Project, editor: Editor, file: PsiFile): IntentionPreviewInfo = IntentionPreviewInfo.EMPTY

    override fun invoke(project: Project, editor: Editor?, file: PsiFile?) {
        val vf = file?.virtualFile ?: return
        Fixer.apply(project, vf, finding.entry, fix)
    }
}
