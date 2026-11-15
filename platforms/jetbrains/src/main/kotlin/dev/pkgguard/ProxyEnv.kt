package dev.pkgguard

import com.intellij.util.net.ProxyConfiguration
import com.intellij.util.net.ProxyCredentialStore
import com.intellij.util.net.ProxySettings
import java.net.URLEncoder
import java.nio.charset.StandardCharsets.UTF_8

/** The IDE's HTTP proxy as the scanner needs it. [password] is a secret: it only ever goes into the process environment. */
data class ProxyConfig(
    val host: String,
    val port: Int,
    val login: String? = null,
    val password: String? = null,
    val exceptions: String = "",
) {
    // toString is what a log line would print, so keep the credentials out of it
    override fun toString() = "ProxyConfig(host=$host, port=$port, login=${if (login.isNullOrEmpty()) "none" else "***"})"
}

object ProxyEnv {
    /**
     * Environment for the scanner process. Node 24 honours HTTP_PROXY / HTTPS_PROXY / NO_PROXY for `fetch` once NODE_USE_ENV_PROXY is set.
     * With no proxy configured it is empty, so whatever the parent environment already has stays in effect.
     */
    fun variables(proxy: ProxyConfig?): Map<String, String> {
        if (proxy == null || proxy.host.isBlank() || proxy.port <= 0) return emptyMap()
        val auth = if (!proxy.login.isNullOrEmpty()) {
            enc(proxy.login) + (proxy.password?.takeIf { it.isNotEmpty() }?.let { ":" + enc(it) } ?: "") + "@"
        } else ""
        val url = "http://$auth${proxy.host}:${proxy.port}"
        val env = linkedMapOf(
            "NODE_USE_ENV_PROXY" to "1",
            "HTTP_PROXY" to url, "HTTPS_PROXY" to url,
            "http_proxy" to url, "https_proxy" to url,
        )
        val noProxy = proxy.exceptions.split(',', ';', ' ', '\n').map { it.trim() }.filter { it.isNotEmpty() }.joinToString(",")
        if (noProxy.isNotEmpty()) {
            env["NO_PROXY"] = noProxy
            env["no_proxy"] = noProxy
        }
        return env
    }

    /** The proxy set in Settings | Appearance & Behavior | System Settings | HTTP Proxy, or null when none (or a SOCKS / PAC one, which Node cannot take from the environment). */
    fun fromIde(): ProxyConfig? {
        val c = ProxySettings.getInstance().getProxyConfiguration() as? ProxyConfiguration.StaticProxyConfiguration ?: return null
        if (c.protocol != ProxyConfiguration.ProxyProtocol.HTTP) return null
        val host = c.host.trim()
        if (host.isEmpty()) return null
        // Credentials are stored only when the proxy needs authentication
        val creds = ProxyCredentialStore.getInstance().getCredentials(c.host, c.port)
        return ProxyConfig(host, c.port, creds?.userName, creds?.getPasswordAsString(), c.exceptions)
    }

    private fun enc(s: String) = URLEncoder.encode(s, UTF_8).replace("+", "%20")
}
