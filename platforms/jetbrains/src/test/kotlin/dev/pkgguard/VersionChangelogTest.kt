package dev.pkgguard

import org.junit.Assert.assertEquals
import org.junit.Test

class VersionChangelogTest {
    private val newer = listOf("2.0.0", "1.3.0", "1.2.0", "1.1.0") // newest first, all above the installed 1.0.0

    @Test
    fun `installed to this covers everything from the installed version`() {
        val r = versionNotes("pkg", "1.0.0", newer, "1.2.0", thisOnly = false)
        assertEquals(NotesRange("1.0.0", "1.2.0", "pkg 1.0.0 → 1.2.0"), r)
    }

    @Test
    fun `this version only starts at the version before it`() {
        assertEquals(NotesRange("1.1.0", "1.2.0", "pkg 1.2.0"), versionNotes("pkg", "1.0.0", newer, "1.2.0", thisOnly = true))
    }

    @Test
    fun `the oldest newer version starts at the installed one`() {
        assertEquals(NotesRange("1.0.0", "1.1.0", "pkg 1.1.0"), versionNotes("pkg", "1.0.0", newer, "1.1.0", thisOnly = true))
    }

    @Test
    fun `the newest version only`() {
        assertEquals(NotesRange("1.3.0", "2.0.0", "pkg 2.0.0"), versionNotes("pkg", "1.0.0", newer, "2.0.0", thisOnly = true))
    }
}
