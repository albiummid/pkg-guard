package dev.pkgguard

import com.intellij.openapi.project.Project
import java.lang.reflect.Method

/**
 * Whether the user trusts the project, which gates everything that runs code from it (installs, scripts, `npm audit`).
 *
 * The platform has no single trust API that is current on every build this plugin supports:
 *  - 252 and later: `TrustedProjects.isProjectTrusted(Project)`.
 *  - 242 to 251: only the Kotlin extension `Project.isTrusted()` in `com.intellij.ide.impl`, which 252 deprecates.
 * Calling either one directly would leave a deprecated or experimental reference in the plugin on one side of that range, so the
 * available one is looked up by name once. When neither exists the project counts as untrusted: failing closed means no command is run.
 */
object ProjectTrust {
    private val check: Method? = find("com.intellij.ide.trustedProjects.TrustedProjects", "isProjectTrusted")
        ?: find("com.intellij.ide.impl.TrustedProjects", "isTrusted")

    private fun find(className: String, method: String): Method? = try {
        Class.forName(className).getMethod(method, Project::class.java).takeIf { java.lang.reflect.Modifier.isStatic(it.modifiers) }
    } catch (e: ReflectiveOperationException) {
        null
    }

    fun isTrusted(project: Project): Boolean = try {
        check?.invoke(null, project) as? Boolean ?: false
    } catch (e: ReflectiveOperationException) {
        false
    }
}
