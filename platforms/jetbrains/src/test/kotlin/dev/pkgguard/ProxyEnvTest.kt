package dev.pkgguard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProxyEnvTest {
    @Test
    fun `no proxy leaves the environment alone`() {
        assertTrue(ProxyEnv.variables(null).isEmpty())
        assertTrue(ProxyEnv.variables(ProxyConfig("", 8080)).isEmpty())
    }

    @Test
    fun `a proxy turns on the environment proxy of node`() {
        val env = ProxyEnv.variables(ProxyConfig("proxy.corp", 3128, exceptions = "localhost, *.corp;10.0.0.1"))
        assertEquals("1", env["NODE_USE_ENV_PROXY"])
        assertEquals("http://proxy.corp:3128", env["HTTPS_PROXY"])
        assertEquals("localhost,*.corp,10.0.0.1", env["NO_PROXY"])
    }

    @Test
    fun `credentials are encoded and never printed`() {
        val cfg = ProxyConfig("p", 1, "me@x", "pa:ss/w")
        assertEquals("http://me%40x:pa%3Ass%2Fw@p:1", ProxyEnv.variables(cfg)["HTTP_PROXY"])
        assertFalse(cfg.toString().contains("pa:ss"))
        assertFalse(cfg.toString().contains("me@x"))
    }
}
