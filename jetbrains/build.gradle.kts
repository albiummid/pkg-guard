import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.2.1"
}

group = "dev.pkgguard"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        // WebStorm has the same platform + JSON modules; develop against IDEA Community for a smaller download.
        create(IntelliJPlatformType.IntellijIdeaCommunity, "2024.2.5")
        bundledPlugin("com.intellij.modules.json")
        instrumentationTools()
        pluginVerifier()
    }
}

kotlin { jvmToolchain(17) }

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "242"
            untilBuild = provider { null }
        }
    }
}

// The Node sidecar: one bundled JS file built from ../src by `yarn build:server`, shipped inside the plugin jar.
val isWindows = System.getProperty("os.name").lowercase().contains("win")
val buildServer by tasks.registering(Exec::class) {
    workingDir = file("..")
    commandLine(if (isWindows) listOf("cmd", "/c", "yarn", "build:server") else listOf("yarn", "build:server"))
    inputs.dir("../src")
    outputs.file("../dist/server.js")
}
val copyServer by tasks.registering(Copy::class) {
    dependsOn(buildServer)
    from("../dist/server.js")
    into(layout.buildDirectory.dir("generated/pkgguard-resources/pkgguard"))
}
sourceSets.main { resources.srcDir(layout.buildDirectory.dir("generated/pkgguard-resources")) }
tasks.processResources { dependsOn(copyServer) }
