package dev.pkgguard

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiManager
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
    private val periodic = Alarm(Alarm.ThreadToUse.POOLED_THREAD, this)

    /** Import warnings per JS/TS file path, for the end-of-line text. */
    val importStates = ConcurrentHashMap<String, List<ImportFinding>>()
    val sidecar: Sidecar get() = project.service()
    val settings: PkgGuardSettings get() = project.service()

    private val coordinator = ScanCoordinator(
        scanner = { path, text -> sidecar.call<ScanResponse>("scan", mapOf("text" to text, "pkgFile" to path, "settings" to settings.forSidecar(project))) },
        onResult = { _, _ -> if (!project.isDisposed) project.messageBus.syncPublisher(PKG_GUARD_TOPIC).changed() },
        onError = { e ->
            log.warn("scan failed", e)
            if (!project.isDisposed) notify(project, e.message ?: "Scan failed", NotificationType.ERROR)
        },
        checkCanceled = { ProgressManager.checkCanceled() },
        isCancellation = { it is ProcessCanceledException },
    )

    val states: Map<String, ScanResponse> get() = coordinator.states

    /** Editor buffer when the file is open (may be unsaved), else the file on disk. */
    fun textOf(file: VirtualFile): String = ReadAction.nonBlocking<String> {
        FileDocumentManager.getInstance().getDocument(file)?.text ?: String(file.contentsToByteArray(), Charsets.UTF_8)
    }.executeSynchronously()

    /** Scans `text` of `file`. The last result is reused when the text is unchanged; [force] always asks the scanner again. */
    fun scanText(file: VirtualFile, text: String, force: Boolean = false): ScanResponse? = coordinator.scan(file.path, text, force)

    fun scan(file: VirtualFile): ScanResponse? = scanText(file, textOf(file))

    /**
     * Scan results of the package.jsons above a source file, nearest first, up to the content root that holds the file.
     * A file outside every content root (a scratch file, a library) has none. Scans the ones not scanned yet.
     */
    fun manifestsAbove(file: VirtualFile): List<ScanResponse> {
        val root = ReadAction.nonBlocking<VirtualFile?> { ProjectFileIndex.getInstance(project).getContentRootForFile(file) }.executeSynchronously() ?: return emptyList()
        val out = mutableListOf<ScanResponse>()
        var dir = file.parent
        while (dir != null) {
            dir.findChild("package.json")?.let { pkg -> scan(pkg)?.let(out::add) }
            if (dir == root) break
            dir = dir.parent
        }
        return out
    }

    /** Every package.json of the project outside node_modules. Waits for indexing; gives up when the service is disposed. */
    fun findProjects(): List<VirtualFile> =
        ReadAction.nonBlocking<List<VirtualFile>> {
            FilenameIndex.getVirtualFilesByName("package.json", GlobalSearchScope.projectScope(project))
                .filter { !it.path.contains("/node_modules/") }
                .sortedBy { it.path }
        }.inSmartMode(project).expireWith(this).executeSynchronously()

    /** Re-scans every package.json of the project in the background, then re-runs the inspections. */
    fun refreshAll(clearCaches: Boolean) {
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                if (clearCaches) sidecar.call<Boolean>("clearCache")
                for (file in findProjects()) {
                    if (project.isDisposed) break
                    coordinator.scan(file.path, textOf(file), force = true)
                }
            } catch (e: ProcessCanceledException) {
                // the project closed or the service was disposed while waiting
            } catch (e: Exception) {
                log.warn("refresh failed", e)
            } finally {
                ApplicationManager.getApplication().invokeLater({ if (!project.isDisposed) DaemonRestart.restart(project) }, project.disposed)
            }
        }
    }

    /** Debounced: an install touches many files at once. */
    fun scheduleRefresh() {
        alarm.cancelAllRequests()
        alarm.addRequest({ refreshAll(clearCaches = false) }, 500)
    }

    /** New advisories are published all the time; without this an IDE left open never sees them. Re-arms itself. */
    fun schedulePeriodicRefresh() {
        periodic.cancelAllRequests()
        val hours = settings.state.refreshIntervalHours.coerceAtMost(168)
        if (hours > 0) periodic.addRequest({
            refreshAll(clearCaches = true)
            schedulePeriodicRefresh()
        }, hours * 3_600_000L)
    }

    /** Re-runs the import warnings of the open JS / TS files, after a package.json's findings changed. */
    fun refreshImportWarnings() {
        ApplicationManager.getApplication().invokeLater({
            val psi = PsiManager.getInstance(project)
            for (f in FileEditorManager.getInstance(project).openFiles) {
                if (isSourceFile(f)) psi.findFile(f)?.let { DaemonRestart.restart(project, it) }
            }
        }, project.disposed)
    }

    override fun dispose() {}
}
