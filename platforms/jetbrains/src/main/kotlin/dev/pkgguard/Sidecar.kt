package dev.pkgguard

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import java.io.IOException
import java.nio.charset.StandardCharsets.UTF_8
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

/** The bundled Node scanner (src/server.ts of the repo), written to the IDE's system folder once per IDE session. */
object ScannerScript {
    private var extracted: Path? = null

    /**
     * Writes the script through a temporary file and an atomic move, so a second project (or IDE) starting at the same moment
     * never reads a half-written file. The first call per session replaces whatever an older plugin version left behind.
     */
    @Synchronized
    fun path(): Path {
        extracted?.takeIf { Files.exists(it) }?.let { return it }
        val dir = Path.of(PathManager.getSystemPath(), "pkg-guard")
        Files.createDirectories(dir)
        val target = dir.resolve("server.js")
        val res = ScannerScript::class.java.getResourceAsStream("/pkgguard/server.js")
            ?: error("server.js is missing from the plugin. Run `yarn cli core build:server` and rebuild the plugin.")
        val tmp = Files.createTempFile(dir, "server-", ".js")
        try {
            res.use { Files.copy(it, tmp, StandardCopyOption.REPLACE_EXISTING) }
            try {
                Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (e: IOException) {
                // another process holds the old file open (Windows): it is the same script, so use it
                if (!Files.exists(target)) throw e
            }
        } finally {
            Files.deleteIfExists(tmp)
        }
        extracted = target
        return target
    }
}

/** One Node scanner process per project; see [SidecarClient]. */
@Service(Service.Level.PROJECT)
class Sidecar(private val project: Project) : Disposable {
    private val log = logger<Sidecar>()

    val client = SidecarClient(
        launch = ::launch,
        checkCanceled = { ProgressManager.checkCanceled() },
        onStderr = { log.warn("sidecar: $it") },
        onBadLine = { line, e -> log.warn("bad sidecar line: $line", e) },
    )

    private fun launch(): Process {
        val node = project.service<PkgGuardSettings>().state.nodePath.ifBlank { "node" }
        return try {
            GeneralCommandLine(node, ScannerScript.path().toString()).withCharset(UTF_8).createProcess()
        } catch (e: Exception) {
            throw IllegalStateException("Could not start Node.js (\"$node\"). Install Node 24+ or set its path in Settings | Tools | Pkg Guard. ${e.message}", e)
        }
    }

    inline fun <reified T> call(method: String, params: Any = emptyMap<String, Any>(), timeoutSec: Long = 120): T = client.call(method, params, timeoutSec)

    fun restart() = client.restart()

    override fun dispose() = client.restart()
}
