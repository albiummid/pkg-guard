package dev.pkgguard

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.reflect.TypeToken
import java.io.BufferedWriter
import java.io.IOException
import java.lang.reflect.Type
import java.nio.charset.StandardCharsets.UTF_8
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicLong

/** A request was cut short because the scanner was restarted on purpose (settings changed). Not a failure of the scan itself. */
class ScannerRestartedException : RuntimeException("The Pkg Guard scanner was restarted")

/**
 * Line-delimited JSON client of the Node scanner: one request per line on its stdin, one reply per line on its stdout.
 * Calls block, so never call them on the EDT.
 *
 * Every process has its own table of pending requests. A process that dies (or is replaced by [restart]) can therefore only fail
 * the requests that were sent to it, never one that already went to its successor.
 *
 * Nothing here depends on the IDE: [launch] starts the process and [checkCanceled] lets the caller's progress indicator interrupt a wait,
 * so the whole client can be driven by a scripted fake process in a plain unit test.
 */
class SidecarClient(
    private val launch: () -> Process,
    private val checkCanceled: () -> Unit = {},
    private val onStderr: (String) -> Unit = {},
    private val onBadLine: (String, Exception) -> Unit = { _, _ -> },
) {
    private val gson = Gson()
    private val ids = AtomicLong()
    private var current: Connection? = null

    private inner class Connection(val process: Process) {
        val stdin: BufferedWriter = process.outputStream.bufferedWriter(UTF_8)
        private val pending = ConcurrentHashMap<Long, CompletableFuture<JsonElement>>()
        private var closed = false

        init {
            Thread({
                process.inputStream.bufferedReader(UTF_8).forEachLine(::onLine)
                failAll(RuntimeException("The Pkg Guard scanner process exited"))
            }, "pkg-guard-stdout").apply { isDaemon = true }.start()
            Thread({ process.errorStream.bufferedReader(UTF_8).forEachLine(onStderr) }, "pkg-guard-stderr").apply { isDaemon = true }.start()
        }

        val isUsable: Boolean @Synchronized get() = !closed && process.isAlive

        @Synchronized
        fun register(id: Long, future: CompletableFuture<JsonElement>): Boolean {
            if (closed) return false
            pending[id] = future
            return true
        }

        fun forget(id: Long) {
            pending.remove(id)
        }

        @Synchronized
        fun failAll(error: RuntimeException) {
            closed = true
            pending.values.forEach { it.completeExceptionally(error) }
            pending.clear()
        }

        private fun onLine(line: String) {
            if (line.isBlank()) return
            try {
                val msg = gson.fromJson(line, JsonObject::class.java)
                val id = msg.get("id")?.takeIf { !it.isJsonNull }?.asLong ?: return
                val future = pending[id] ?: return
                if (msg.has("error")) future.completeExceptionally(RuntimeException(msg.get("error").asString)) else future.complete(msg.get("result"))
            } catch (e: Exception) {
                onBadLine(line, e)
            }
        }
    }

    @Synchronized
    private fun connection(): Connection {
        current?.takeIf { it.isUsable }?.let { return it }
        return Connection(launch()).also { current = it }
    }

    @PublishedApi
    internal fun <T> request(method: String, params: Any, type: Type, timeoutSec: Long): T {
        val conn = connection()
        val id = ids.incrementAndGet()
        val future = CompletableFuture<JsonElement>()
        if (!conn.register(id, future)) throw IllegalStateException("The Pkg Guard scanner process exited")
        try {
            val req = JsonObject().apply {
                addProperty("id", id)
                addProperty("method", method)
                add("params", gson.toJsonTree(params))
            }
            try {
                synchronized(conn.stdin) {
                    conn.stdin.write(gson.toJson(req))
                    conn.stdin.newLine()
                    conn.stdin.flush()
                }
            } catch (e: IOException) {
                throw IllegalStateException("The Pkg Guard scanner process exited", e)
            }
            return gson.fromJson(await(future, method, timeoutSec), type)
        } finally {
            conn.forget(id)
        }
    }

    /** Waits in short slices so a cancelled progress indicator interrupts the wait instead of the full timeout. */
    private fun await(future: CompletableFuture<JsonElement>, method: String, timeoutSec: Long): JsonElement {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSec)
        while (true) {
            checkCanceled()
            val left = deadline - System.nanoTime()
            if (left <= 0) throw IllegalStateException("The Pkg Guard scanner did not answer \"$method\" within ${timeoutSec}s. This is usually a slow or blocked network; the next scan tries again.")
            try {
                return future.get(minOf(left, TimeUnit.MILLISECONDS.toNanos(100)), TimeUnit.NANOSECONDS)
            } catch (e: TimeoutException) {
                continue
            } catch (e: ExecutionException) {
                throw e.cause as? ScannerRestartedException ?: RuntimeException(e.cause?.message ?: e.message, e.cause)
            }
        }
    }

    inline fun <reified T> call(method: String, params: Any = emptyMap<String, Any>(), timeoutSec: Long = 120): T =
        request(method, params, object : TypeToken<T>() {}.type, timeoutSec)

    @Synchronized
    fun restart() {
        current?.let {
            // fail the pending requests first: destroying the process makes its reader thread report "exited"
            it.failAll(ScannerRestartedException())
            it.process.destroy()
        }
        current = null
    }
}
