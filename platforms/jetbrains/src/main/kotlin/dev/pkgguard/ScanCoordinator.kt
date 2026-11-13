package dev.pkgguard

import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Decides when a package.json is scanned, and keeps the results. Independent of the IDE: [scanner] does the actual (blocking) scan,
 * so the rules can be tested with a scripted one.
 *
 *  - One scan per manifest is in flight at a time. A caller that asks for the same text while one runs waits for it.
 *  - A result is stored only if no scan that started later has stored its own: an older result never replaces a newer one.
 *  - Asking again for text that was just scanned returns the stored result, unless [force]d (new advisories, a changed lockfile…).
 *  - [onError] is told about a failure once; after the next success it will be told about the next failure again.
 */
class ScanCoordinator(
    private val scanner: (path: String, text: String) -> ScanResponse,
    private val onResult: (path: String, result: ScanResponse) -> Unit = { _, _ -> },
    private val onError: (Exception) -> Unit = {},
    private val checkCanceled: () -> Unit = {},
    /** True for the platform's "this operation was cancelled" exception, which is control flow, not a failed scan. */
    private val isCancellation: (Throwable) -> Boolean = { false },
) {
    private class Job(val text: String, val forced: Boolean, val seq: Long) {
        val done = CompletableFuture<ScanResponse?>()
        @Volatile var abandoned = false
    }

    private class Slot {
        var text: String? = null
        var committed = 0L
        var inflight: Job? = null
    }

    private val slots = ConcurrentHashMap<String, Slot>()
    private val seqs = AtomicLong()
    private val reported = AtomicBoolean()

    /** Latest stored result per manifest path. */
    val states = ConcurrentHashMap<String, ScanResponse>()

    /** Scans `text` of the manifest at `path`, or returns what the scan already running / just finished for it produced. Null when the scan failed. */
    fun scan(path: String, text: String, force: Boolean = false): ScanResponse? {
        val slot = slots.computeIfAbsent(path) { Slot() }
        while (true) {
            checkCanceled()
            var job: Job
            var owner = false
            synchronized(slot) {
                val cached = states[path]
                if (!force && cached != null && slot.text == text) return cached
                val running = slot.inflight
                if (running != null && running.text == text && (!force || running.forced)) {
                    job = running
                } else {
                    job = Job(text, force, seqs.incrementAndGet())
                    slot.inflight = job
                    owner = true
                }
            }
            if (owner) return run(path, slot, job)
            val shared = await(job)
            if (!job.abandoned) return shared // otherwise the scan we waited for was cancelled: start our own
        }
    }

    private fun run(path: String, slot: Slot, job: Job): ScanResponse? {
        var result: ScanResponse? = null
        try {
            val fresh = scanner(path, job.text)
            val stored = synchronized(slot) {
                if (job.seq > slot.committed) {
                    slot.committed = job.seq
                    slot.text = job.text
                    states[path] = fresh
                    true
                } else {
                    false
                }
            }
            reported.set(false)
            if (stored) onResult(path, fresh)
            result = if (stored) fresh else states[path] ?: fresh
            return result
        } catch (e: Exception) {
            if (isCancellation(e)) {
                job.abandoned = true
                throw e
            }
            if (reported.compareAndSet(false, true)) onError(e)
            return null
        } finally {
            synchronized(slot) { if (slot.inflight === job) slot.inflight = null }
            job.done.complete(result)
        }
    }

    private fun await(job: Job): ScanResponse? {
        while (true) {
            checkCanceled()
            try {
                return job.done.get(100, TimeUnit.MILLISECONDS)
            } catch (e: TimeoutException) {
                continue
            }
        }
    }
}
