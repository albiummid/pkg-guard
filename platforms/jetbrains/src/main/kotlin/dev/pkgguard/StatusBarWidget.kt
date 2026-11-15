package dev.pkgguard

import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.util.messages.Topic
import com.intellij.util.Consumer
import java.awt.Component
import java.awt.event.MouseEvent
import java.util.concurrent.atomic.AtomicInteger

/**
 * What the status bar shows: vulnerable and Transitive vulnerability Findings, and available Updates, counted the way VS Code counts
 * them for its open manifest. The JetBrains widget has no "open manifest", so it sums over all of the project's scanned manifests
 * (the ticket asks for "the project's manifests").
 */
class StatusCounts(val vulnerable: Int, val updates: Int, private val sources: List<String>) {
    val text: String get() = "$vulnerable vulnerable · $updates updates"
    val sourceName: String get() = sources.joinToString(", ")

    companion object {
        /** Null when no manifest has been scanned. */
        fun of(scans: Collection<ScanResponse>): StatusCounts? {
            if (scans.isEmpty()) return null
            val findings = scans.flatMap { it.findings }
            return StatusCounts(
                vulnerable = findings.count { it.kind == "vuln" || it.kind == "transitive" },
                updates = findings.count { it.kind == "outdated" },
                sources = scans.map { it.source }.distinct().map(::sourceLabel),
            )
        }
    }
}

/** Published when a scan starts or ends. */
val PKG_GUARD_BUSY_TOPIC: Topic<PkgGuardListener> = Topic.create("Pkg Guard scan activity", PkgGuardListener::class.java)

/** Counts the scans in flight. A failed scan still ends its busy period. */
class ScanActivity(private val onChange: () -> Unit = {}) {
    private val running = AtomicInteger()
    val busy: Boolean get() = running.get() > 0

    fun <T> track(block: () -> T): T {
        running.incrementAndGet()
        onChange()
        try {
            return block()
        } finally {
            running.decrementAndGet()
            onChange()
        }
    }
}

class PkgGuardStatusBarWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = ID
    override fun getDisplayName() = "Pkg Guard"

    override fun createWidget(project: Project): StatusBarWidget = PkgGuardStatusBarWidget(project)

    companion object {
        const val ID = "dev.pkgguard.status"
    }
}

private class PkgGuardStatusBarWidget(private val project: Project) : StatusBarWidget, StatusBarWidget.TextPresentation {
    private var statusBar: StatusBar? = null
    private val connection = project.messageBus.connect(this)

    override fun ID() = PkgGuardStatusBarWidgetFactory.ID
    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        connection.subscribe(PKG_GUARD_TOPIC, PkgGuardListener { statusBar.updateWidget(ID()) })
        connection.subscribe(PKG_GUARD_BUSY_TOPIC, PkgGuardListener { statusBar.updateWidget(ID()) })
    }

    private val service get() = project.service<PkgGuardService>()

    /** Blank (so nothing shows) until a package.json of the project has been scanned or is being scanned. */
    override fun getText(): String {
        if (service.activity.busy) return "Pkg Guard: scanning…"
        if (service.states.isEmpty()) return ""
        return "Pkg Guard: " + (StatusCounts.of(service.states.values)?.text ?: "no data")
    }

    override fun getTooltipText(): String? {
        if (service.states.isEmpty() && !service.activity.busy) return null
        val source = StatusCounts.of(service.states.values)?.sourceName ?: sourceLabel("none")
        return "Pkg Guard ($source) — click to re-scan"
    }

    override fun getAlignment() = Component.LEFT_ALIGNMENT

    override fun getClickConsumer(): Consumer<MouseEvent> = Consumer { service.refreshAll(clearCaches = true) }

    override fun dispose() {
        statusBar = null
    }
}
