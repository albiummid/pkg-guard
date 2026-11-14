package dev.pkgguard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

private fun response(tag: String) = ScanResponse(
    entries = emptyList(), installed = mapOf("tag" to tag), findings = emptyList(), info = emptyMap(), bumps = emptyMap(),
    lock = "none", pm = Pm("npm", "npm install", "overrides"), source = "osv", notes = emptyList(),
)

private fun ScanResponse?.tag(): String? = this?.installed?.get("tag")

class ScanCoordinatorTest {
    private fun <T> async(block: () -> T): CompletableFuture<T> = CompletableFuture.supplyAsync(block)

    @Test
    fun `callers asking for the same text while a scan runs share it`() {
        val calls = AtomicInteger()
        val release = CountDownLatch(1)
        val c = ScanCoordinator(scanner = { _, text -> calls.incrementAndGet(); release.await(); response(text) })
        val results = (1..5).map { async { c.scan("/p/package.json", "v1") } }
        Thread.sleep(150) // let all five reach the coordinator while the first scan is blocked
        release.countDown()
        results.forEach { assertEquals("v1", it.get(5, TimeUnit.SECONDS).tag()) }
        assertEquals(1, calls.get())
    }

    @Test
    fun `unchanged text reuses the stored result and a forced scan asks again`() {
        val calls = AtomicInteger()
        val c = ScanCoordinator(scanner = { _, text -> response("$text#${calls.incrementAndGet()}") })
        assertEquals("v1#1", c.scan("/p", "v1").tag())
        assertEquals("v1#1", c.scan("/p", "v1").tag())
        assertEquals("v1#2", c.scan("/p", "v1", force = true).tag())
        assertEquals("v2#3", c.scan("/p", "v2").tag())
        assertEquals(3, calls.get())
    }

    @Test
    fun `an older scan finishing late never replaces a newer result`() {
        val releaseOld = CountDownLatch(1)
        val oldStarted = CountDownLatch(1)
        val c = ScanCoordinator(scanner = { _, text ->
            if (text == "old") {
                oldStarted.countDown()
                releaseOld.await()
            }
            response(text)
        })
        val old = async { c.scan("/p", "old") }
        oldStarted.await()
        assertEquals("new", c.scan("/p", "new").tag()) // starts later, finishes first
        releaseOld.countDown()
        assertEquals("new", old.get(5, TimeUnit.SECONDS).tag()) // the caller of the old scan is handed the newer stored result
        assertEquals("new", c.states["/p"].tag())
    }

    @Test
    fun `different manifests are scanned independently`() {
        val c = ScanCoordinator(scanner = { path, _ -> response(path) })
        assertEquals("/a", c.scan("/a", "x").tag())
        assertEquals("/b", c.scan("/b", "x").tag())
        assertEquals(setOf("/a", "/b"), c.states.keys)
    }

    @Test
    fun `a failure is reported once and again after a success`() {
        val errors = CopyOnWriteArrayList<String>()
        var failing = true
        val c = ScanCoordinator(scanner = { _, text -> if (failing) error("scanner down") else response(text) }, onError = { errors += it.message.orEmpty() })
        assertNull(c.scan("/p", "v1"))
        assertNull(c.scan("/p", "v2"))
        assertEquals(listOf("scanner down"), errors) // not repeated for every highlighting pass
        failing = false
        assertEquals("v3", c.scan("/p", "v3").tag())
        failing = true
        assertNull(c.scan("/p", "v4"))
        assertEquals(listOf("scanner down", "scanner down"), errors) // re-armed by the success in between
    }

    @Test
    fun `an expected interruption is neither reported nor stored`() {
        class Restarted : RuntimeException()
        val errors = CopyOnWriteArrayList<String>()
        val calls = AtomicInteger()
        val c = ScanCoordinator(
            scanner = { _, text -> if (calls.incrementAndGet() == 1) throw Restarted() else response(text) },
            onError = { errors += it.message.orEmpty() },
            isBenign = { it is Restarted },
        )
        assertNull(c.scan("/p", "v1"))
        assertTrue("an interruption caused by a restart must not show an error", errors.isEmpty())
        assertNull(c.states["/p"])
        assertEquals("v1", c.scan("/p", "v1").tag()) // the follow-up scan after the restart works as usual
    }

    @Test
    fun `a failed scan is not stored and the next call tries again`() {
        val calls = AtomicInteger()
        val c = ScanCoordinator(scanner = { _, text -> if (calls.incrementAndGet() == 1) error("first fails") else response(text) })
        assertNull(c.scan("/p", "v1"))
        assertEquals("v1", c.scan("/p", "v1").tag())
        assertEquals(2, calls.get())
    }

    @Test
    fun `a cancelled scan lets a waiting caller start its own`() {
        class Cancelled : RuntimeException()
        val started = CountDownLatch(1)
        val proceed = CountDownLatch(1)
        val calls = AtomicInteger()
        val c = ScanCoordinator(
            scanner = { _, text ->
                if (calls.incrementAndGet() == 1) {
                    started.countDown()
                    proceed.await()
                    throw Cancelled()
                }
                response(text)
            },
            isCancellation = { it is Cancelled },
        )
        val first = async { try { c.scan("/p", "v1"); "finished" } catch (e: Cancelled) { "cancelled" } }
        started.await()
        val waiter = async { c.scan("/p", "v1") }
        Thread.sleep(150) // the waiter is now waiting on the first scan
        proceed.countDown()
        assertEquals("cancelled", first.get(5, TimeUnit.SECONDS))
        assertEquals("v1", waiter.get(5, TimeUnit.SECONDS).tag())
        assertTrue(calls.get() == 2)
    }

    @Test
    fun `results are published when stored`() {
        val published = CopyOnWriteArrayList<String>()
        val c = ScanCoordinator(scanner = { _, text -> response(text) }, onResult = { path, r -> published += "$path=${r.tag()}" })
        c.scan("/p", "v1")
        c.scan("/p", "v1") // reused: nothing new to publish
        c.scan("/p", "v2")
        assertEquals(listOf("/p=v1", "/p=v2"), published)
        assertSame(c.states["/p"], c.scan("/p", "v2"))
    }

    @Test
    fun `opening scans each manifest exactly once, also when one was already scanned or is running`() {
        val calls = CopyOnWriteArrayList<String>()
        val release = CountDownLatch(1)
        val c = ScanCoordinator(scanner = { path, text ->
            calls += path
            if (path == "/slow") release.await()
            response(text)
        })
        c.scan("/open", "text") // highlighted before the project-wide scan got to it
        val running = async { c.scan("/slow", "text") }
        Thread.sleep(150)
        val all = async { c.scanAll(listOf("/a", "/open", "/slow", "/b", "/a")) { "text" } }
        Thread.sleep(150)
        release.countDown()
        all.get(5, TimeUnit.SECONDS)
        running.get(5, TimeUnit.SECONDS)
        assertEquals(listOf("/a", "/b", "/open", "/slow"), calls.sorted())
        assertEquals(setOf("/a", "/b", "/open", "/slow"), c.states.keys)
    }

    @Test
    fun `scanning no manifests does nothing and a failing one does not stop the others`() {
        val calls = AtomicInteger()
        val errors = CopyOnWriteArrayList<String>()
        val c = ScanCoordinator(scanner = { path, text -> calls.incrementAndGet(); if (path == "/bad") error("boom") else response(text) }, onError = { errors += it.message.orEmpty() })
        c.scanAll(emptyList()) { "text" }
        assertEquals(0, calls.get())
        c.scanAll(listOf("/bad", "/good")) { "text" }
        assertEquals(setOf("/good"), c.states.keys)
        assertEquals(listOf("boom"), errors)
    }
}
