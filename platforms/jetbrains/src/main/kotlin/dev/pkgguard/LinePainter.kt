package dev.pkgguard

import com.intellij.openapi.editor.DefaultLanguageHighlighterColors
import com.intellij.openapi.editor.EditorLinePainter
import com.intellij.openapi.editor.LineExtensionInfo
import com.intellij.openapi.editor.colors.CodeInsightColors
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.vfs.VirtualFile
import java.awt.Font

private val RANK = mapOf("error" to 3, "warning" to 2, "info" to 1)

/** Short italic text after the end of a line with findings, like the VS Code ghost text: package.json dependency lines and import lines. */
class PkgGuardLinePainter : EditorLinePainter() {
    override fun getLineExtensions(project: Project, file: VirtualFile, lineNumber: Int): Collection<LineExtensionInfo>? {
        val service = project.getServiceIfCreated(PkgGuardService::class.java) ?: return null
        val doc = FileDocumentManager.getInstance().getCachedDocument(file) ?: return null
        if (lineNumber >= doc.lineCount) return null
        val text = doc.getText(TextRange(doc.getLineStartOffset(lineNumber), doc.getLineEndOffset(lineNumber)))
        // (level, inline) of this line; each one is skipped when the line no longer holds what was scanned (edited since)
        val hints: List<Pair<String, String>> = when {
            isPackageJson(file) -> service.states[file.path]?.findings.orEmpty()
                .filter { it.entry.line == lineNumber && text.startsWith("\"${it.entry.name}\"", it.entry.nameStart) }
                .map { it.level to it.inline }
            isSourceFile(file) && service.settings.state.importWarnings -> service.importStates[file.path].orEmpty()
                .filter { it.ref.line == lineNumber && it.ref.end <= text.length && text.substring(it.ref.start + 1, it.ref.end - 1).let { s -> s == it.ref.name || s.startsWith(it.ref.name + "/") } }
                .map { it.level to it.inline }
            else -> emptyList()
        }
        if (hints.isEmpty()) return null
        val sorted = hints.sortedByDescending { RANK[it.first] ?: 0 }
        return listOf(LineExtensionInfo("   " + sorted.joinToString("  ") { it.second }, attributes(sorted[0].first)))
    }

    /** Italic, in the color the scheme uses for errors / warnings / inlay hints, so it follows the theme. */
    private fun attributes(level: String): TextAttributes {
        val scheme = EditorColorsManager.getInstance().globalScheme
        val key: TextAttributesKey = when (level) {
            "error" -> CodeInsightColors.ERRORS_ATTRIBUTES
            "warning" -> CodeInsightColors.WARNINGS_ATTRIBUTES
            else -> DefaultLanguageHighlighterColors.INLAY_DEFAULT
        }
        val a = scheme.getAttributes(key)
        val color = a?.effectColor ?: a?.foregroundColor ?: scheme.getAttributes(DefaultLanguageHighlighterColors.LINE_COMMENT)?.foregroundColor
        return TextAttributes(color, null, null, null, Font.ITALIC)
    }
}
