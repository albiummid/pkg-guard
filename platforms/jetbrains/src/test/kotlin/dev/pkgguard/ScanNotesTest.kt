package dev.pkgguard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ScanNotesTest {
    @Test
    fun `a failed vulnerability check is told apart from informational notes`() {
        assertTrue(isCheckFailure("vulnerability check failed: OSV.dev unreachable (x) and the npm audit failed too (y)"))
        assertTrue(isCheckFailure("vulnerability check failed: boom"))
        assertFalse(isCheckFailure("OSV.dev unreachable (x); used npm audit instead"))
        assertFalse(isCheckFailure("pnpm-lock.yaml is not supported yet; transitive vulnerability checks are off"))
    }

    @Test
    fun `the data source is named for the user`() {
        assertEquals("OSV.dev", sourceLabel("osv"))
        assertEquals("audit CLI", sourceLabel("audit"))
        assertEquals("none", sourceLabel("none"))
        assertEquals("none", sourceLabel("whatever"))
    }
}
