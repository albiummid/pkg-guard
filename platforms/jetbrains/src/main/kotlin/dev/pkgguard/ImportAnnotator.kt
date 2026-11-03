package dev.pkgguard

import com.intellij.lang.annotation.AnnotationHolder
import com.intellij.lang.annotation.ExternalAnnotator
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiFile

private val SOURCE_EXTENSIONS = setOf("js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue", "svelte", "astro")

fun isSourceFile(file: VirtualFile): Boolean = file.extension?.lowercase() in SOURCE_EXTENSIONS && !file.path.contains("/node_modules/")

/** Import warnings: the vulnerability findings of a dependency, repeated on the imports of that package in JS / TS files. */
class ImportAnnotator : ExternalAnnotator<ImportAnnotator.Input, List<ImportFinding>>() {
    private val log = logger<ImportAnnotator>()

    class Input(val file: VirtualFile, val text: String, val project: Project)

    override fun collectInformation(file: PsiFile): Input? {
        val vf = file.virtualFile ?: return null
        if (!isSourceFile(vf)) return null
        // registered for every language: a .vue file has several, annotate it once
        if (file.language != file.viewProvider.baseLanguage) return null
        if (!file.project.service<PkgGuardSettings>().state.importWarnings) {
            file.project.service<PkgGuardService>().importStates.remove(vf.path)
            return null
        }
        return Input(vf, file.text, file.project)
    }

    override fun doAnnotate(input: Input?): List<ImportFinding>? {
        input ?: return null
        val service = input.project.service<PkgGuardService>()
        return try {
            val manifests = service.manifestsAbove(input.file).map { mapOf("entries" to it.entries, "findings" to it.findings) }
            val result: List<ImportFinding> =
                if (manifests.isEmpty()) emptyList() else service.sidecar.call("importFindings", mapOf("text" to input.text, "manifests" to manifests))
            service.importStates[input.file.path] = result
            result
        } catch (e: Exception) {
            log.warn("import warnings failed for ${input.file.path}", e)
            null
        }
    }

    override fun apply(file: PsiFile, result: List<ImportFinding>?, holder: AnnotationHolder) {
        result ?: return
        val doc = file.viewProvider.document ?: return
        for (f in result) {
            if (f.ref.line >= doc.lineCount) continue
            val lineStart = doc.getLineStartOffset(f.ref.line)
            if (lineStart + f.ref.end > doc.getLineEndOffset(f.ref.line)) continue
            holder.newAnnotation(severityOf(f.level), f.message).range(TextRange(lineStart + f.ref.start, lineStart + f.ref.end)).create()
        }
    }
}
