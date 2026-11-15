package dev.pkgguard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EmptyStateTest {
    @Test
    fun `no package json says so and what Pkg Guard needs`() {
        val text = emptyStateText(manifestCount = 0)
        assertTrue(text.contains("No package.json found"))
        assertTrue(text.contains("needs a package.json"))
    }

    @Test
    fun `nothing is said while manifests exist, scanned or still being scanned`() {
        assertEquals("", emptyStateText(manifestCount = 1))
        assertEquals("", emptyStateText(manifestCount = 5))
    }
}
