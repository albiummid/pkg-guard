package dev.pkgguard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FixPlanTest {
    private fun entry(name: String, section: String) = Entry(name, "^1.0.0", section, 0, 0, 0, 0, 0)

    private fun vuln(name: String, section: String, range: String) =
        Finding("vuln", entry(name, section), "error", "m", inline = "i", fixes = listOf(Fix("setVersion", "t", range = range)))

    private fun transitive(name: String, range: String) =
        Finding("transitive", entry("host", "dependencies"), "error", "m", inline = "i", fixes = listOf(Fix("addOverride", "t", section = "resolutions", name = name, range = range)))

    @Test
    fun `a package declared in two sections is updated in both`() {
        val plan = FixPlan.of(listOf(vuln("a", "dependencies", "^1.2.3"), vuln("a", "devDependencies", "^1.2.3")))
        assertEquals(listOf("dependencies", "devDependencies"), plan.updates.map { it.section })
        assertEquals(listOf("1.2.3", "1.2.3"), plan.updates.map { it.version })
    }

    @Test
    fun `update ranges lose their operator and pins are collected once per package`() {
        val plan = FixPlan.of(listOf(vuln("a", "dependencies", ">=2.0.0"), transitive("qs", "^6.0.4"), transitive("qs", "^6.0.4")))
        assertEquals("2.0.0", plan.updates.single().version)
        assertEquals(1, plan.pins.size)
        assertEquals("qs", plan.pins.single().name)
    }

    @Test
    fun `other kinds of finding are not fixes of this action`() {
        val outdated = Finding("outdated", entry("a", "dependencies"), "info", "m", inline = "i", fixes = listOf(Fix("setVersion", "t", range = "^2.0.0")))
        assertTrue(FixPlan.of(listOf(outdated)).isEmpty)
    }

    @Test
    fun `the confirmation lists every update and pin`() {
        val plan = FixPlan.of(listOf(vuln("a", "dependencies", "^1.2.3"), transitive("qs", "^6.0.4")))
        val text = plan.describe("package.json")
        assertTrue(text.contains("update a"))
        assertTrue(text.contains("pin qs"))
        assertTrue(text.contains("package.json"))
    }
}
