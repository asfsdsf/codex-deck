import assert from "node:assert/strict";
import test from "node:test";
import { codexProxyEnvironment } from "../../api/codex-proxy";

test("configured proxies override both spellings without changing inherited variables", () => {
  const inherited = {
    http_proxy: "http://shell-proxy:7890",
    HTTPS_PROXY: "http://shell-proxy:7890",
    no_proxy: "shell-only",
    ALL_PROXY: "socks5://shell-proxy:7891",
  };
  const env = {
    ...inherited,
    ...codexProxyEnvironment({
      httpProxy: " http://config-proxy:7890 ",
      noProxy: "localhost",
    }),
  };
  assert.equal(env.http_proxy, "http://config-proxy:7890");
  assert.equal(env.HTTP_PROXY, "http://config-proxy:7890");
  assert.equal(env.NO_PROXY, "localhost");
  assert.equal(env.no_proxy, "localhost");
  assert.equal(env.HTTPS_PROXY, inherited.HTTPS_PROXY);
  assert.equal(env.ALL_PROXY, inherited.ALL_PROXY);
  assert.equal(inherited.http_proxy, "http://shell-proxy:7890");
});
