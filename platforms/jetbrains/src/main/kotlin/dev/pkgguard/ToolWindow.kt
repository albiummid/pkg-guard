package dev.pkgguard

import com.google.gson.JsonParser
import com.intellij.icons.AllIcons
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.PopupHandler
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.ScrollPaneFactory
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.treeStructure.Tree
import java.awt.Component
import java.awt.datatransfer.StringSelection
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.JTree
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel

private sealed interface Node
private data class ProjectNode(val file: VirtualFile) : Node
private data class SectionNode(val title: String) : Node
private data class DepNode(val file: VirtualFile, val entry: Entry) : Node
private data class VersionNode(val file: VirtualFile, val entry: Entry, val version: String) : Node
private data class ScriptNode(val file: VirtualFile, val name: String, val command: String) : Node

class PkgGuardToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = PkgGuardPanel(project)
        toolWindow.contentManager.addContent(ContentFactory.getInstance().createContent(panel, "", false))
        Disposer.register(toolWindow.disposable, panel)
        panel.reload()
    }
}

private class PkgGuardPanel(private val project: Project) : SimpleToolWindowPanel(true, true), com.intellij.openapi.Disposable {
    private val svc = project.service<PkgGuardService>()
    private val model = DefaultTreeModel(DefaultMutableTreeNode())
    private val tree = Tree(model)

    init {
        tree.isRootVisible = false
        tree.cellRenderer = Renderer()
        setContent(ScrollPaneFactory.createScrollPane(tree))

        val refresh = object : DumbAwareAction("Refresh", "Re-scan all package.json files", AllIcons.Actions.Refresh) {
            override fun actionPerformed(e: AnActionEvent) = svc.refreshAll(clearCaches = true)
        }
        toolbar = ActionManager.getInstance().createActionToolbar(ActionPlaces.TOOLWINDOW_TOOLBAR_BAR, DefaultActionGroup(refresh), true).also { it.targetComponent = this }.component

        tree.addMouseListener(object : PopupHandler() {
            override fun invokePopup(comp: Component, x: Int, y: Int) {
                val node = selected() ?: return
                val actions = actionsFor(node)
                if (actions.isNotEmpty()) ActionManager.getInstance().createActionPopupMenu("PkgGuardPopup", DefaultActionGroup(actions)).component.show(comp, x, y)
            }
        })
        tree.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 2) when (val n = selected()) {
                    is DepNode -> open(n.file, n.entry.line, n.entry.nameStart)
                    is ProjectNode -> open(n.file, 0, 0)
                    else -> {}
                }
            }
        })
        project.messageBus.connect(this).subscribe(PKG_GUARD_TOPIC, PkgGuardListener { ApplicationManager.getApplication().invokeLater({ reload() }, project.disposed) })
    }

    private fun selected(): Node? = (tree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject as? Node

    private fun open(file: VirtualFile, line: Int, col: Int) = OpenFileDescriptor(project, file, line, col).navigate(true)

    /** Rebuilds the tree from the cached scan results; scans projects that have none yet. */
    fun reload() {
        ApplicationManager.getApplication().executeOnPooledThread {
            val files = svc.findProjects()
            files.filter { !svc.states.containsKey(it.path) }.forEach { svc.scan(it) }
            val scripts = files.associateWith { scriptsOf(it) }
            ApplicationManager.getApplication().invokeLater({
                val root = DefaultMutableTreeNode()
                for (f in files) {
                    val st = svc.states[f.path] ?: continue
                    val p = DefaultMutableTreeNode(ProjectNode(f))
                    for (section in listOf("dependencies", "devDependencies", "optionalDependencies")) {
                        val deps = st.entries.filter { it.section == section }
                        if (deps.isEmpty()) continue
                        val s = DefaultMutableTreeNode(SectionNode("$section (${deps.size})"))
                        for (e in deps) {
                            val d = DefaultMutableTreeNode(DepNode(f, e))
                            st.info[e.name]?.versions.orEmpty().take(30).forEach { d.add(DefaultMutableTreeNode(VersionNode(f, e, it))) }
                            s.add(d)
                        }
                        p.add(s)
                    }
                    val sc = scripts[f].orEmpty()
                    if (sc.isNotEmpty()) p.add(DefaultMutableTreeNode(SectionNode("scripts (${sc.size})")).also { s -> sc.forEach { (n, c) -> s.add(DefaultMutableTreeNode(ScriptNode(f, n, c))) } })
                    root.add(p)
                }
                val expanded = (0 until tree.rowCount).filter { tree.isExpanded(it) }
                model.setRoot(root)
                (0 until root.childCount).forEach { tree.expandRow(it) }
                expanded.forEach { if (it < tree.rowCount) tree.expandRow(it) }
            }, project.disposed)
        }
    }

    private fun scriptsOf(file: VirtualFile): Map<String, String> = try {
        JsonParser.parseString(svc.textOf(file)).asJsonObject.getAsJsonObject("scripts")?.entrySet()?.associate { it.key to it.value.asString }.orEmpty()
    } catch (e: Exception) {
        emptyMap()
    }

    private fun actionsFor(node: Node): List<AnAction> {
        fun act(title: String, run: () -> Unit) = DumbAwareAction.create(title) { run() }
        return when (node) {
            is ProjectNode -> {
                val st = svc.states[node.file.path]
                listOfNotNull(
                    st?.let { act("Install all dependencies") { Installer.install(project, node.file, it.pm) } },
                    act("Re-scan this project") { ApplicationManager.getApplication().executeOnPooledThread { svc.scan(node.file) } },
                    act("Update all — patch") { UpdateFlow.updateAll(project, node.file, "patch") },
                    act("Update all — minor") { UpdateFlow.updateAll(project, node.file, "minor") },
                    act("Update all — major") { UpdateFlow.updateAll(project, node.file, "major") },
                    act("Open package.json") { open(node.file, 0, 0) },
                )
            }
            is DepNode -> {
                val st = svc.states[node.file.path]
                val bump = st?.bumps?.get(node.entry.name)
                val latest = st?.info?.get(node.entry.name)?.versions?.firstOrNull()
                listOfNotNull(
                    latest?.let { act("Update to latest ($it)") { UpdateFlow.update(project, node.file, node.entry, it) } },
                    bump?.patch?.let { act("Update to newest patch ($it)") { UpdateFlow.update(project, node.file, node.entry, it) } },
                    bump?.minor?.let { act("Update to newest minor ($it)") { UpdateFlow.update(project, node.file, node.entry, it) } },
                    bump?.major?.let { act("Update to newest major ($it)") { UpdateFlow.update(project, node.file, node.entry, it) } },
                    act("Update to version…") { UpdateFlow.update(project, node.file, node.entry, null) },
                    act("Check compatibility with version…") { UpdateFlow.update(project, node.file, node.entry, null, onlyReport = true) },
                    act("Show changelog…") { UpdateFlow.changelog(project, node.file, node.entry) },
                    act("Open on npm") { BrowserUtil.browse("https://www.npmjs.com/package/${node.entry.name}") },
                    act("Open repository") { UpdateFlow.openRepo(project, node.entry) },
                    act("Go to dependency") { open(node.file, node.entry.line, node.entry.nameStart) },
                    act("Copy package name") { com.intellij.openapi.ide.CopyPasteManager.getInstance().setContents(StringSelection(node.entry.name)) },
                )
            }
            is VersionNode -> listOf(act("Update to ${node.version}") { UpdateFlow.update(project, node.file, node.entry, node.version) })
            is ScriptNode -> listOf(act("Run script") {
                val pm = svc.states[node.file.path]?.pm?.name ?: "npm"
                Installer.run(project, node.file.parent.path, "$pm run ${node.name}")
            })
            is SectionNode -> emptyList()
        }
    }

    override fun dispose() {}

    private inner class Renderer : ColoredTreeCellRenderer() {
        override fun customizeCellRenderer(tree: JTree, value: Any?, selected: Boolean, expanded: Boolean, leaf: Boolean, row: Int, hasFocus: Boolean) {
            when (val n = (value as? DefaultMutableTreeNode)?.userObject) {
                is ProjectNode -> {
                    icon = AllIcons.Nodes.Module
                    val rel = project.basePath?.let { n.file.path.removePrefix(it).trimStart('/') } ?: n.file.path
                    append(rel, SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
                    val vulns = svc.states[n.file.path]?.findings?.count { it.kind == "vuln" || it.kind == "transitive" } ?: 0
                    if (vulns > 0) append("  $vulns vulnerable", SimpleTextAttributes.ERROR_ATTRIBUTES)
                }
                is SectionNode -> append(n.title, SimpleTextAttributes.GRAYED_BOLD_ATTRIBUTES)
                is DepNode -> {
                    val st = svc.states[n.file.path]
                    val findings = st?.findings?.filter { it.entry.name == n.entry.name && it.entry.section == n.entry.section }.orEmpty()
                    val worst = if (findings.any { it.level == "error" }) SimpleTextAttributes.ERROR_ATTRIBUTES else if (findings.any { it.level == "warning" }) SimpleTextAttributes.ERROR_ATTRIBUTES.derive(SimpleTextAttributes.STYLE_PLAIN, com.intellij.ui.JBColor.ORANGE, null, null) else SimpleTextAttributes.REGULAR_ATTRIBUTES
                    icon = AllIcons.Nodes.PpLib
                    append(n.entry.name, worst)
                    st?.installed?.get(n.entry.name)?.let { append("  $it", SimpleTextAttributes.GRAYED_ATTRIBUTES) }
                    st?.bumps?.get(n.entry.name)?.let { b ->
                        val parts = listOfNotNull(b.patch?.let { "patch $it" }, b.minor?.let { "minor $it" }, b.major?.let { "major $it" })
                        if (parts.isNotEmpty()) append("  → " + parts.joinToString(" · "), SimpleTextAttributes.GRAY_ITALIC_ATTRIBUTES)
                    }
                    if (findings.any { it.kind == "vuln" || it.kind == "transitive" }) append("  ⚠ vulnerable", SimpleTextAttributes.ERROR_ATTRIBUTES)
                    if (findings.any { it.kind == "deprecated" }) append("  deprecated", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                }
                is VersionNode -> {
                    append(n.version)
                    val installed = svc.states[n.file.path]?.installed?.get(n.entry.name)
                    if (n.version == installed) append("  installed", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                }
                is ScriptNode -> {
                    icon = AllIcons.Actions.Execute
                    append(n.name)
                    append("  ${n.command}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                }
            }
        }
    }
}
