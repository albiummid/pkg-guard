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

intellijPlatform {
    instrumentCode = false // Kotlin only: no .form files or @NotNull instrumentation needed
    pluginConfiguration {
        ideaVersion {
            sinceBuild = providers.gradleProperty("pkgguard.sinceBuild").get()
            untilBuild = provider { null }
        }
    }
    // Only used by `publishPlugin` (the release workflow sets PUBLISH_TOKEN from a repository secret).
    publishing { token = providers.environmentVariable("PUBLISH_TOKEN") }
}

// The Node sidecar is built by the root CLI and shipped inside the plugin jar.
val isWindows = System.getProperty("os.name").lowercase().contains("win")
val repoRoot = file("../..")
val coreDir = repoRoot
val buildServer by tasks.registering(Exec::class) {
    workingDir = repoRoot
    commandLine(if (isWindows) listOf("cmd", "/c", "node", "scripts/cli.js", "core", "build:server") else listOf("node", "scripts/cli.js", "core", "build:server"))
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
