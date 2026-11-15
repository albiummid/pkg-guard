package dev.pkgguard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.ConcurrentHashMap

class ImportStatesTest {
    private fun states() = ConcurrentHashMap<String, List<ImportFinding>>().apply {
        put("/p/src/a.ts", emptyList())
        put("/p/src/b.ts", emptyList())
        put("/p/srcother/c.ts", emptyList())
    }

    @Test
    fun `a closed or deleted file loses its state and the others keep theirs`() {
        val s = states()
        assertTrue(dropImportStates(s, listOf("/p/src/a.ts")))
        assertEquals(setOf("/p/src/b.ts", "/p/srcother/c.ts"), s.keys)
    }

    @Test
    fun `a deleted folder drops everything below it but not a sibling with the same prefix`() {
        val s = states()
        assertTrue(dropImportStates(s, listOf("/p/src")))
        assertEquals(setOf("/p/srcother/c.ts"), s.keys)
    }

    @Test
    fun `nothing to drop reports false and a file that comes back is stored again`() {
        val s = states()
        assertFalse(dropImportStates(s, listOf("/p/none.ts")))
        dropImportStates(s, listOf("/p/src/a.ts"))
        s["/p/src/a.ts"] = emptyList()
        assertTrue(s.containsKey("/p/src/a.ts"))
    }
}
