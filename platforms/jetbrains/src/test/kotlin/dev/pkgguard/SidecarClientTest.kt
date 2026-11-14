package dev.pkgguard

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.InputStream
import java.io.OutputStream
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** A scripted scanner process: the test reads the requests the client wrote and decides when (and whether) to answer. */
private class FakeProcess : Process() {
    private val toProcess = PipedOutputStream()
    private val requestsIn = PipedInputStream(toProcess, 1 shl 16)
    private val replies = PipedOutputStream()
    private val repliesOut = PipedInputStream(replies, 1 shl 16)
    private val requests = LinkedBlockingQueue<JsonObject>()
    @Volatile private var exited = false

    init {
        Thread {
            requestsIn.bufferedReader().forEachLine { requests.put(JsonParser.parseString(it).asJsonObject) }
        }.apply { isDaemon = true }.start()
    }

    /** Blocks until the client has sent its next request. */
    fun nextRequest(): JsonObject = requests.poll(5, TimeUnit.SECONDS) ?: error("the client sent no request")

    fun reply(id: Long, result: String) = send("""{"id":$id,"result":"$result"}""")

    fun replyError(id: Long, message: String) = send("""{"id":$id,"error":"$message"}""")

    private fun send(line: String) = synchronized(replies) {
        replies.write((line + "\n").toByteArray())
        replies.flush()
    }

    /** The process ends: its output closes, which the client sees as end of stream. */
    fun exit() {
        exited = true
        replies.close()
    }

    override fun getOutputStream(): OutputStream = toProcess
    override fun getInputStream(): InputStream = repliesOut
    override fun getErrorStream(): InputStream = InputStream.nullInputStream()
    override fun waitFor(): Int = 0
    override fun exitValue(): Int = if (exited) 0 else throw IllegalThreadStateException()
    override fun destroy() = exit()
}

class SidecarClientTest {
    private fun client(vararg processes: FakeProcess, checkCanceled: () -> Unit = {}): Pair<SidecarClient, AtomicInteger> {
        val launched = AtomicInteger()
        val c = SidecarClient(launch = { processes[launched.getAndIncrement()] }, checkCanceled = checkCanceled)
        return c to launched
    }

    private fun <T> async(block: () -> T): CompletableFuture<T> = CompletableFuture.supplyAsync(block)

    @Test
    fun `a reply reaches the caller that sent the request`() {
        val p = FakeProcess()
        val (c, _) = client(p)
        val result = async { c.call<String>("ping") }
        val req = p.nextRequest()
        assertEquals("ping", req.get("method").asString)
        p.reply(req.get("id").asLong, "pong")
        assertEquals("pong", result.get(5, TimeUnit.SECONDS))
    }

    @Test
    fun `replies that arrive out of order still reach their own callers`() {
        val p = FakeProcess()
        val (c, _) = client(p)
        val a = async { c.call<String>("a") }
        val first = p.nextRequest()
        val b = async { c.call<String>("b") }
        val second = p.nextRequest()
        p.reply(second.get("id").asLong, "for-${second.get("method").asString}")
        p.reply(first.get("id").asLong, "for-${first.get("method").asString}")
        assertEquals("for-a", a.get(5, TimeUnit.SECONDS))
        assertEquals("for-b", b.get(5, TimeUnit.SECONDS))
    }

    @Test
    fun `an error reply surfaces its message`() {
        val p = FakeProcess()
        val (c, _) = client(p)
        val result = async { c.call<String>("boom") }
        p.replyError(p.nextRequest().get("id").asLong, "no such method")
        try {
            result.get(5, TimeUnit.SECONDS)
            fail("expected an error")
        } catch (e: Exception) {
            assertTrue(e.toString(), e.toString().contains("no such method"))
        }
    }

    @Test
    fun `restarting fails the pending request and the old process ending later does not fail the new one`() {
        val old = FakeProcess()
        val next = FakeProcess()
        val (c, launched) = client(old, next)
        val inFlight = async { c.call<String>("slow") }
        old.nextRequest()

        c.restart()
        try {
            inFlight.get(5, TimeUnit.SECONDS)
            fail("the request sent to the replaced process must fail")
        } catch (e: Exception) {
            assertTrue(e.toString(), e.toString().contains("restarted"))
            // callers tell an intended restart from a failed scan by its type
            assertTrue(e.toString(), generateSequence<Throwable>(e) { it.cause }.any { it is ScannerRestartedException })
        }

        val fresh = async { c.call<String>("fresh") }
        val req = next.nextRequest()
        assertEquals(2, launched.get())
        old.exit() // the old process's output ends only now; its reader thread must not touch the new process's requests
        Thread.sleep(200)
        assertFalse("the new request was failed by the old process ending", fresh.isDone)
        next.reply(req.get("id").asLong, "ok")
        assertEquals("ok", fresh.get(5, TimeUnit.SECONDS))
    }

    @Test
    fun `a process that exits fails what it was asked and the next call starts a new one`() {
        val dying = FakeProcess()
        val next = FakeProcess()
        val (c, launched) = client(dying, next)
        val pending = async { c.call<String>("x") }
        dying.nextRequest()
        dying.exit()
        try {
            pending.get(5, TimeUnit.SECONDS)
            fail("expected the request to fail")
        } catch (e: Exception) {
            assertTrue(e.toString(), e.toString().contains("exited"))
        }
        val again = async { c.call<String>("y") }
        next.reply(next.nextRequest().get("id").asLong, "back")
        assertEquals("back", again.get(5, TimeUnit.SECONDS))
        assertEquals(2, launched.get())
    }

    @Test
    fun `cancelling the caller interrupts the wait without waiting for the timeout`() {
        val p = FakeProcess()
        val sent = CountDownLatch(1)
        var cancel = false
        val (c, _) = client(p, checkCanceled = { if (cancel) throw CancellationException() })
        val result = async {
            try {
                sent.countDown()
                c.call<String>("slow", timeoutSec = 60)
            } catch (e: CancellationException) {
                "cancelled"
            }
        }
        sent.await()
        p.nextRequest()
        val started = System.nanoTime()
        cancel = true
        assertEquals("cancelled", result.get(5, TimeUnit.SECONDS))
        assertTrue("took too long to notice the cancel", System.nanoTime() - started < TimeUnit.SECONDS.toNanos(3))
    }

    @Test
    fun `a timeout names the method and the limit`() {
        val p = FakeProcess()
        val (c, _) = client(p)
        val result = async { c.call<String>("scan", timeoutSec = 1) }
        p.nextRequest() // never answered
        try {
            result.get(10, TimeUnit.SECONDS)
            fail("expected a timeout")
        } catch (e: Exception) {
            val text = e.toString()
            assertTrue(text, text.contains("\"scan\"") && text.contains("1s"))
        }
    }

    private class CancellationException : RuntimeException()
}
