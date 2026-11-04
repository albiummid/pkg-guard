import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.2.1"
}

group = "dev.pkgguard"
version = providers.gradleProperty("version").get()

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        // WebStorm has the same platform + JSON modules; develop against IDEA Community for a smaller download.
        create(IntelliJPlatformType.IntellijIdeaCommunity, providers.gradleProperty("pkgguard.ideaVersion").get())
        pluginVerifier()
    }
}

kotlin { jvmToolchain(providers.gradleProperty("pkgguard.jvm").get().toInt()) }

// The Node sidecar and the change notes come from the root CLI.
val isWindows = System.getProperty("os.name").lowercase().contains("win")
val repoRoot = file("../..")
fun cli(vararg args: String) = (if (isWindows) listOf("cmd", "/c", "node", "scripts/cli.js") else listOf("node", "scripts/cli.js")) + args

// This version's CHANGELOG.md section as HTML; empty for a dev build whose version has no section yet.
val changeNotesHtml = providers.exec {
    workingDir = repoRoot
    commandLine(cli("changelog", "notes", version.toString(), "--html"))
    isIgnoreExitValue = true
}.standardOutput.asText

intellijPlatform {
    instrumentCode = false // Kotlin only: no .form files or @NotNull instrumentation needed
    pluginConfiguration {
        ideaVersion {
            sinceBuild = providers.gradleProperty("pkgguard.sinceBuild").get()
            untilBuild = provider { null }
        }
        changeNotes = changeNotesHtml
    }
    // Only used by `signPlugin` / `publishPlugin`; the release workflow sets these from repository secrets.
    signing {
        certificateChain = providers.environmentVariable("CERTIFICATE_CHAIN")
        privateKey = providers.environmentVariable("PRIVATE_KEY")
        password = providers.environmentVariable("PRIVATE_KEY_PASSWORD")
    }
    publishing { token = providers.environmentVariable("PUBLISH_TOKEN") }
    // Oldest supported IDE and the last standalone IDEA Community release (2025.3+ ships as unified IntelliJ IDEA,
    // which this Gradle plugin version cannot resolve, so `recommended()` fails).
    pluginVerification {
        ides {
            ide(IntelliJPlatformType.IntellijIdeaCommunity, providers.gradleProperty("pkgguard.ideaVersion").get())
            ide(IntelliJPlatformType.IntellijIdeaCommunity, "2025.2.4")
        }
    }
}

val coreDir = repoRoot
val buildServer by tasks.registering(Exec::class) {
    workingDir = repoRoot
    commandLine(cli("core", "build:server"))
    inputs.dir(coreDir.resolve("src"))
    outputs.file(coreDir.resolve("dist/sidecar/server.js"))
}
val copyServer by tasks.registering(Copy::class) {
    dependsOn(buildServer)
    from(coreDir.resolve("dist/sidecar/server.js"))
    into(layout.buildDirectory.dir("generated/pkgguard-resources/pkgguard"))
}
val copyPluginLogo by tasks.registering(Copy::class) {
    from("src/main/resources/icons/pluginIcon.svg")
    into(layout.buildDirectory.dir("generated/pkgguard-resources/META-INF"))
}
sourceSets.main { resources.srcDir(layout.buildDirectory.dir("generated/pkgguard-resources")) }
tasks.processResources { dependsOn(copyServer, copyPluginLogo) }

// After the build, copy the plugin zip to <repo root>/output/jetbrains.
val copyToOutput by tasks.registering(Copy::class) {
    from(tasks.buildPlugin.flatMap { it.archiveFile })
    into(file("../../output/jetbrains"))
}
tasks.buildPlugin { finalizedBy(copyToOutput) }
