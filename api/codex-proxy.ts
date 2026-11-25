import type { CodexDeckProxyConfig } from "./config";

const PROXY_ENV_KEYS = {
  httpProxy: "HTTP_PROXY",
  httpsProxy: "HTTPS_PROXY",
  noProxy: "NO_PROXY",
} as const;

export function codexProxyEnvironment(
  proxy?: CodexDeckProxyConfig,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const property of Object.keys(PROXY_ENV_KEYS) as Array<
    keyof CodexDeckProxyConfig
  >) {
    const value = proxy?.[property]?.trim();
    if (!value) continue;
    const key = PROXY_ENV_KEYS[property];
    // HTTP clients differ in which spelling they prefer. Override both so
    // a lowercase value inherited from the shell cannot shadow the config.
    env[key] = value;
    env[key.toLowerCase()] = value;
  }
  return env;
}

export function hasCodexProxyEnvironment(env?: NodeJS.ProcessEnv): boolean {
  return Object.values(PROXY_ENV_KEYS).some(
    (key) => !!(env?.[key]?.trim() || env?.[key.toLowerCase()]?.trim()),
  );
}

export function equalCodexProxyConfig(
  left?: CodexDeckProxyConfig,
  right?: CodexDeckProxyConfig,
): boolean {
  return (
    Object.keys(PROXY_ENV_KEYS) as Array<keyof CodexDeckProxyConfig>
  ).every((property) => left?.[property]?.trim() === right?.[property]?.trim());
}
