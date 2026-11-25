import { spawn } from "node:child_process";
import { codexProxyEnvironment } from "./codex-proxy";
import type { CodexDeckProxyConfig } from "./config";

/** curl honors daemon proxy settings on supported Node versions, including Node 20. */
export function pluginHttpRequest(
  input: Record<string, unknown>,
  proxy?: CodexDeckProxyConfig,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  const url = new URL(String(input.url));
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Expected an HTTP(S) URL without credentials.");
  const headers = input.headers as Record<string, string> | undefined;
  const args = [
    "--silent",
    "--show-error",
    "--max-time",
    "120",
    "--max-filesize",
    "4194304",
    "--request",
    "POST",
    "--url",
    url.href,
    "--write-out",
    "\n%{http_code}",
    "--config",
    "-",
  ];
  const quote = (value: string) =>
    `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
  const config = [`data-binary = ${quote(JSON.stringify(input.body ?? {}))}`];
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (
      !/^[a-z0-9-]+$/i.test(name) ||
      typeof value !== "string" ||
      /[\r\n]/.test(value)
    )
      throw new Error("Invalid HTTP header.");
    config.push(`header = ${quote(`${name}: ${value}`)}`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn("curl", args, {
      env: { ...process.env, ...codexProxyEnvironment(proxy) },
      stdio: ["pipe", "pipe", "pipe"],
      signal,
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output) > 4 * 1024 * 1024) child.kill();
    });
    // Never expose stderr, headers, URLs with tokens, or request bodies in errors.
    child.stderr.resume();
    child.stdin.on("error", () => {});
    // Keep bearer credentials out of process arguments and shell history.
    child.stdin.end(`${config.join("\n")}\n`);
    child.once("error", () =>
      reject(new Error("Provider request could not start.")),
    );
    child.once("close", (code) => {
      if (code !== 0)
        return reject(
          new Error(
            code === 28
              ? "Provider request timed out."
              : "Provider network request failed.",
          ),
        );
      const split = output.lastIndexOf("\n");
      resolve({
        status: Number(output.slice(split + 1)),
        body: output.slice(0, split),
      });
    });
  });
}
