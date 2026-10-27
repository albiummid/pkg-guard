package dev.pkgguard

import com.intellij.codeInsight.daemon.DaemonCodeAnalyzer
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.DumbService
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.search.FilenameIndex
import com.intellij.psi.search.GlobalSearchScope
import com.intellij.util.Alarm
import com.intellij.util.messages.Topic
import java.util.concurrent.ConcurrentHashMap

fun interface PkgGuardListener {
    fun changed()
}

val PKG_GUARD_TOPIC: Topic<PkgGuardListener> = Topic.create("Pkg Guard scan results", PkgGuardListener::class.java)

fun notify(project: Project, message: String, type: NotificationType = NotificationType.INFORMATION) {
    NotificationGroupManager.getInstance().getNotificationGroup("Pkg Guard").createNotification(message, type).notify(project)
}

/** Scan results per package.json (key: file path), shared by the annotator and the tool window. */
@Service(Service.Level.PROJECT)
class PkgGuardService(private val project: Project) : Disposable {
    private val log = logger<PkgGuardService>()
    private val alarm = Alarm(Alarm.ThreadToUse.POOLED_THREAD, this)
    private var warnedAboutNode = false

    val states = ConcurrentHashMap<String, ScanResponse>()
    val sidecar: Sidecar get() = project.service()
    val settings: PkgGuardSettings get() = project.service()

    /** Editor buffer when the file is open (may be unsaved), else the file on disk. */
    fun textOf(file: VirtualFile): String = ReadAction.compute<String, RuntimeException> {
        FileDocumentManager.getInstance().getDocument(file)?.text ?: String(file.contentsToByteArray(), Charsets.UTF_8)
    }

    fun scanText(file: VirtualFile, text: String): ScanResponse? = try {
        val result: ScanResponse = sidecar.call("scan", mapOf("text" to text, "pkgFile" to file.path, "settings" to settings.forSidecar(project)))
        states[file.path] = result
        project.messageBus.syncPublisher(PKG_GUARD_TOPIC).changed()
        result
    } catch (e: Exception) {
        log.warn("scan failed for ${file.path}", e)
        if (!warnedAboutNode) {
            warnedAboutNode = true
            notify(project, e.message ?: "Scan failed", NotificationType.ERROR)
        }
        null
    }

    fun scan(file: VirtualFile): ScanResponse? = scanText(file, textOf(file))

    fun findProjects(): List<VirtualFile> = DumbService.getInstance(project).runReadActionInSmartMode<List<VirtualFile>> {
        FilenameIndex.getVirtualFilesByName("package.json", GlobalSearchScope.projectScope(project))
            .filter { !it.path.contains("/node_modules/") }
            .sortedBy { it.path }
    }

    /** Re-scans every package.json of the project in the background, then re-runs the inspections. */
    fun refreshAll(clearCaches: Boolean) {
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                if (clearCaches) sidecar.call<Boolean>("clearCache")
                findProjects().forEach { scan(it) }
            } finally {
                ApplicationManager.getApplication().invokeLater({ if (!project.isDisposed) DaemonCodeAnalyzer.getInstance(project).restart() }, project.disposed)
            }
        }
    }

    /** Debounced: an install touches many files at once. */
    fun scheduleRefresh() {
        alarm.cancelAllRequests()
        alarm.addRequest({ refreshAll(clearCaches = false) }, 500)
    }

    override fun dispose() {}
}
