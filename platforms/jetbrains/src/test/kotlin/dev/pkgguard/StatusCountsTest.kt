package dev.pkgguard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

private val entry = Entry("a", "^1.0.0", "dependencies", 0, 0, 0, 0, 0)

private fun finding(kind: String) = Finding(kind = kind, entry = entry, level = "warning", message = "m", inline = "i")

private fun scan(source: String, vararg kinds: String) = ScanResponse(
    entries = emptyList(), installed = emptyMap(), findings = kinds.map(::finding), info = emptyMap(), bumps = emptyMap(),
    lock = "none", pm = Pm("npm", "npm install", "overrides"), source = source, notes = emptyList(),
)

class StatusCountsTest {
    @Test
    fun `counts direct and transitive vulnerabilities and updates, ignoring other kinds`() {
        val c = StatusCounts.of(listOf(scan("osv", "vuln", "transitive", "outdated", "deprecated", "stale", "unsynced", "vuln")))!!
        assertEquals(3, c.vulnerable)
        assertEquals(1, c.updates)
        assertEquals("3 vulnerable · 1 updates", c.text)
    }

    @Test
    fun `sums over every manifest`() {
        val c = StatusCounts.of(listOf(scan("osv", "vuln"), scan("osv", "outdated", "outdated")))!!
        assertEquals(1, c.vulnerable)
        assertEquals(2, c.updates)
    }

    @Test
    fun `no scanned manifest means no counts`() {
        assertNull(StatusCounts.of(emptyList()))
    }

    @Test
    fun `tooltip names the data source`() {
        assertEquals("OSV.dev", StatusCounts.of(listOf(scan("osv")))!!.sourceName)
        assertEquals("audit CLI", StatusCounts.of(listOf(scan("audit")))!!.sourceName)
        assertEquals("none", StatusCounts.of(listOf(scan("none")))!!.sourceName)
        assertEquals("OSV.dev, audit CLI", StatusCounts.of(listOf(scan("osv"), scan("audit"), scan("osv")))!!.sourceName)
    }

    @Test
    fun `activity is busy only while a scan runs, also when it fails`() {
        val a = ScanActivity()
        assertFalse(a.busy)
        val seen = mutableListOf<Boolean>()
        a.track { seen += a.busy }
        runCatching { a.track { error("boom") } }
        assertEquals(listOf(true), seen)
        assertFalse(a.busy)
    }
}
