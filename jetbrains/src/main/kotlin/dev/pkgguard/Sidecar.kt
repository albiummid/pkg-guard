package dev.pkgguard

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.reflect.TypeToken
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import java.io.BufferedWriter
import java.lang.reflect.Type
import java.nio.charset.StandardCharsets.UTF_8
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * Client of the bundled Node process (src/server.ts): one JSON request per line on stdin, one JSON reply per line on stdout.
 * Calls block, so never call them on the EDT.
 */
@Service(Service.Level.PROJECT)
class Sidecar(private val project: Project) : Disposable {
    private val log = logger<Sidecar>()
    private val gson = Gson()
    private val ids = AtomicLong()
    private val pending = ConcurrentHashMap<Long, CompletableFuture<JsonElement>>()
    private var proc: Process? = null
    private var stdin: BufferedWriter? = null

    @Synchronized
    private fun start(): BufferedWriter {
        val running = proc
        if (running != null && running.isAlive) return stdin!!
        val node = project.service<PkgGuardSettings>().state.nodePath.ifBlank { "node" }
        val p = try {
            GeneralCommandLine(node, extractScript().toString()).withCharset(UTF_8).createProcess()
        } catch (e: Exception) {
            throw IllegalStateException("Could not start Node.js (\"$node\"). Install Node 18+ or set its path in Settings | Tools | Pkg Guard. ${e.message}", e)
        }
        proc = p
        stdin = p.outputStream.bufferedWriter(UTF_8)
        Thread({
            p.inputStream.bufferedReader(UTF_8).forEachLine(::onLine)
            failAll("The Pkg Guard scanner process exited")
        }, "pkg-guard-stdout").apply { isDaemon = true }.start()
        Thread({ p.errorStream.bufferedReader(UTF_8).forEachLine { log.warn("sidecar: $it") } }, "pkg-guard-stderr").apply { isDaemon = true }.start()
        return stdin!!
    }

    private fun extractScript(): Path {
        val dir = Path.of(PathManager.getSystemPath(), "pkg-guard")
        Files.createDirectories(dir)
        val target = dir.resolve("server.js")
        val res = Sidecar::class.java.getResourceAsStream("/pkgguard/server.js")
            ?: error("server.js is missing from the plugin. Run `yarn build:server` and rebuild the plugin.")
        res.use { Files.copy(it, target, StandardCopyOption.REPLACE_EXISTING) }
        return target
    }

    private fun onLine(line: String) {
        if (line.isBlank()) return
        try {
            val msg = gson.fromJson(line, JsonObject::class.java)
            val fut = pending[msg.get("id")?.takeIf { !it.isJsonNull }?.asLong ?: return] ?: return
            if (msg.has("error")) fut.completeExceptionally(RuntimeException(msg.get("error").asString)) else fut.complete(msg.get("result"))
        } catch (e: Exception) {
            log.warn("bad sidecar line: $line", e)
        }
    }

    private fun failAll(reason: String) {
        pending.values.forEach { it.completeExceptionally(RuntimeException(reason)) }
        pending.clear()
    }

    @PublishedApi
    internal fun <T> request(method: String, params: Any, type: Type, timeoutSec: Long): T {
        val id = ids.incrementAndGet()
        val fut = CompletableFuture<JsonElement>()
        pending[id] = fut
        try {
            val w = start()
            val req = JsonObject().apply {
                addProperty("id", id)
                addProperty("method", method)
                add("params", gson.toJsonTree(params))
            }
            synchronized(w) {
                w.write(gson.toJson(req))
                w.newLine()
                w.flush()
            }
            val result = try {
                fut.get(timeoutSec, TimeUnit.SECONDS)
            } catch (e: ExecutionException) {
                throw RuntimeException(e.cause?.message ?: e.message, e.cause)
            }
            return gson.fromJson(result, type)
        } finally {
            pending.remove(id)
        }
    }

    inline fun <reified T> call(method: String, params: Any = emptyMap<String, Any>(), timeoutSec: Long = 120): T =
        request(method, params, object : TypeToken<T>() {}.type, timeoutSec)

    @Synchronized
    fun restart() {
        proc?.destroy()
        proc = null
        stdin = null
        failAll("The Pkg Guard scanner was restarted")
    }

    override fun dispose() = restart()
}
