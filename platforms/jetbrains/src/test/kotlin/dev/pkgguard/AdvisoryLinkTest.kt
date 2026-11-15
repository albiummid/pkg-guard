package dev.pkgguard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AdvisoryLinkTest {
    @Test
    fun `http and https links are kept`() {
        assertEquals("https://osv.dev/GHSA-1", advisoryLink("https://osv.dev/GHSA-1"))
        assertEquals("http://example.com/a", advisoryLink(" http://example.com/a "))
        assertEquals("HTTPS://osv.dev/X", advisoryLink("HTTPS://osv.dev/X"))
    }

    @Test
    fun `other schemes, malformed and missing links are dropped`() {
        assertNull(advisoryLink(null))
        assertNull(advisoryLink(""))
        assertNull(advisoryLink("javascript:alert(1)"))
        assertNull(advisoryLink("file:///etc/passwd"))
        assertNull(advisoryLink("ftp://example.com/x"))
        assertNull(advisoryLink("osv.dev/GHSA-1"))
        assertNull(advisoryLink("https://"))
        assertNull(advisoryLink("https://exa mple.com"))
    }

    @Test
    fun `tooltip names the id`() {
        assertEquals("GHSA-1: a <b>", advisoryTooltip("GHSA-1", "a <b>"))
        assertEquals("msg", advisoryTooltip(null, "msg"))
        assertEquals("msg", advisoryTooltip(" ", "msg"))
    }
}
