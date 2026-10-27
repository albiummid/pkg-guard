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
}

// The Node sidecar: one bundled JS file built from ../../core/src by `yarn build:server`, shipped inside the plugin jar.
val isWindows = System.getProperty("os.name").lowercase().contains("win")
val buildServer by tasks.registering(Exec::class) {
    workingDir = file("../../core")
    commandLine(if (isWindows) listOf("cmd", "/c", "yarn", "build:server") else listOf("yarn", "build:server"))
    inputs.dir("../../core/src")
    outputs.file("../../core/dist/server.js")
}
val copyServer by tasks.registering(Copy::class) {
    dependsOn(buildServer)
    from("../../core/dist/server.js")
    into(layout.buildDirectory.dir("generated/pkgguard-resources/pkgguard"))
}
sourceSets.main { resources.srcDir(layout.buildDirectory.dir("generated/pkgguard-resources")) }
tasks.processResources { dependsOn(copyServer) }

// After the build, copy the plugin zip to <repo root>/output/jetbrains.
val copyToOutput by tasks.registering(Copy::class) {
    from(tasks.buildPlugin.flatMap { it.archiveFile })
    into(file("../../output/jetbrains"))
}
tasks.buildPlugin { finalizedBy(copyToOutput) }
