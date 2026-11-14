package dev.pkgguard

import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import org.junit.Assert.assertEquals
import org.junit.Test

class ModelTest {
    private val gson = Gson()

    @Test
    fun `manifest edit replies decode into the Kotlin shapes`() {
        val edits: List<TextEdit> = gson.fromJson(
            """[{"startLine":0,"startChar":0,"endLine":6,"endChar":0,"newText":"{\r\n}\r\n"}]""",
            object : TypeToken<List<TextEdit>>() {}.type,
        )
        assertEquals(listOf(TextEdit(0, 0, 6, 0, "{\r\n}\r\n")), edits)
        val keys: List<KeyLoc> = gson.fromJson("""[{"key":"build","line":5}]""", object : TypeToken<List<KeyLoc>>() {}.type)
        assertEquals(listOf(KeyLoc("build", 5)), keys)
    }

    @Test
    fun `request params serialise with the field names the sidecar reads`() {
        assertEquals("""{"text":"t","section":"dependencies","name":"a","range":"^1.0.0"}""", gson.toJson(AddDependencyParams("t", "dependencies", "a", "^1.0.0")))
        assertEquals("""{"text":"t","name":"a"}""", gson.toJson(RemoveDependencyParams("t", "a")))
        assertEquals("""{"text":"t"}""", gson.toJson(ScriptLocationsParams("t")))
    }
}
