package dev.pkgguard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AttentionTest {
    private fun entry(name: String, section: String = "dependencies") = Entry(name, "^1.0.0", section, 0, 0, 0, 0, 0)
    private fun finding(kind: String, e: Entry) = Finding(kind, e, "warning", "m", inline = "i")

    @Test
    fun `lists dependencies with a vulnerability, transitive vulnerability, deprecation or unsynced install`() {
        val es = listOf("a", "b", "c", "d", "e").map { entry(it) }
        val fs = listOf(finding("vuln", es[0]), finding("transitive", es[1]), finding("deprecated", es[2]), finding("unsynced", es[3]))
        assertEquals(es.take(4), needsAttention(es, fs))
    }

    @Test
    fun `updates and stale ranges alone do not need attention`() {
        val es = listOf(entry("a"), entry("b"))
        assertTrue(needsAttention(es, listOf(finding("outdated", es[0]), finding("stale", es[1]))).isEmpty())
    }

    @Test
    fun `a dependency with several findings is listed once and the same name in another section is separate`() {
        val a = entry("a")
        val aDev = entry("a", "devDependencies")
        val es = listOf(a, aDev)
        assertEquals(listOf(a), needsAttention(es, listOf(finding("vuln", a), finding("deprecated", a))))
    }
}
