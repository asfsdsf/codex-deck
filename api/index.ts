#!/usr/bin/env node
import { program } from "commander";
import { createServer } from "./server";
import { join } from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { createHash } from "crypto";
import { resolveDefaultCodexHome } from "./codex-home";
import {
  loadCodexDeckConfig,
  resolveCodexDeckOptions,
  type CodexDeckCliOptions,
} from "./config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
  try {
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version;
  } catch {
    return "0.1.0";
  }
}

program
  .name("codex-deck")
  .description("A beautiful web UI for browsing Codex CLI conversation history")
  .version(getVersion())
  .option("-p, --port <number>", "Port to listen on", "12001")
  .option("-d, --dir <path>", "Codex directory path", resolveDefaultCodexHome())
  .option("--dev", "Enable CORS for development")
  .option("--no-open", "Do not open browser automatically")
  .option(
    "--remote-server-url <url>",
    "Attach this codex-deck process to a remote codex-deck server (env: CODEXDECK_REMOTE_SERVER_URL)",
  )
  .option(
    "--remote-username <username>",
    "Remote login username bound to this CLI (env: CODEXDECK_REMOTE_USERNAME)",
  )
  .option(
    "--remote-password <password>",
    "Remote login password shared between the web app and this CLI (env: CODEXDECK_REMOTE_PASSWORD)",
  )
  .option(
    "--remote-setup-token <token>",
    "Reusable setup token that authorizes this CLI with the remote server (env: CODEXDECK_REMOTE_SETUP_TOKEN)",
  )
  .option(
    "--remote-machine-id <id>",
    "Stable machine id for remote codex-deck server mode (env: CODEXDECK_REMOTE_MACHINE_ID)",
  )
  .option(
    "--remote-pinned-realm-id <realmId>",
    "Pinned remote auth realm id. Refuse login if server bootstrap realm differs. (env: CODEXDECK_REMOTE_PINNED_REALM_ID)",
  )
  .option(
    "--remote-pinned-opaque-server-key <publicKey>",
    "Pinned remote OPAQUE server public key. Refuse login if bootstrap key differs. (env: CODEXDECK_REMOTE_PINNED_OPAQUE_SERVER_KEY)",
  )
  .parse();

function deriveMachineId(codexDir: string): string {
  return createHash("sha256")
    .update(`${process.platform}:${process.env.HOSTNAME || ""}:${codexDir}`)
    .digest("hex")
    .slice(0, 24);
}

const rawOpts = program.opts<{
  port: string;
  dir: string;
  dev: boolean;
  open: boolean;
  remoteServerUrl?: string;
  remoteUsername?: string;
  remotePassword?: string;
  remoteSetupToken?: string;
  remoteMachineId?: string;
  remotePinnedRealmId?: string;
  remotePinnedOpaqueServerKey?: string;
}>();

function isCliProvided(name: string): boolean {
  return program.getOptionValueSource(name) === "cli";
}

const cliOptions: CodexDeckCliOptions = {
  port: isCliProvided("port") ? rawOpts.port : undefined,
  dir: isCliProvided("dir") ? rawOpts.dir : undefined,
  dev: isCliProvided("dev") ? rawOpts.dev : undefined,
  open: isCliProvided("open") ? rawOpts.open : undefined,
  remoteServerUrl: isCliProvided("remoteServerUrl")
    ? rawOpts.remoteServerUrl
    : undefined,
  remoteUsername: isCliProvided("remoteUsername")
    ? rawOpts.remoteUsername
    : undefined,
  remotePassword: isCliProvided("remotePassword")
    ? rawOpts.remotePassword
    : undefined,
  remoteSetupToken: isCliProvided("remoteSetupToken")
    ? rawOpts.remoteSetupToken
    : undefined,
  remoteMachineId: isCliProvided("remoteMachineId")
    ? rawOpts.remoteMachineId
    : undefined,
  remotePinnedRealmId: isCliProvided("remotePinnedRealmId")
    ? rawOpts.remotePinnedRealmId
    : undefined,
  remotePinnedOpaqueServerKey: isCliProvided("remotePinnedOpaqueServerKey")
    ? rawOpts.remotePinnedOpaqueServerKey
    : undefined,
};

const { paths: configPaths, config } = loadCodexDeckConfig();
for (const path of configPaths) {
  console.log(`Loaded config from ${path}`);
}

const opts = resolveCodexDeckOptions(cliOptions, config);

if (process.env.CODEXDECK_REMOTE_ACCESS_PASSWORD?.trim()) {
  console.error(
    "CODEXDECK_REMOTE_ACCESS_PASSWORD has been removed. Use CODEXDECK_REMOTE_PASSWORD.",
  );
  process.exit(1);
}

if (
  opts.remoteServerUrl &&
  (!opts.remoteSetupToken || !opts.remoteUsername || !opts.remotePassword)
) {
  console.error(
    "Remote mode requires --remote-setup-token, --remote-username, and --remote-password.",
  );
  process.exit(1);
}

const server = createServer({
  port: opts.port,
  codexDir: opts.dir,
  dev: opts.dev,
  open: opts.open,
  remoteServerUrl: opts.remoteServerUrl,
  remoteUsername: opts.remoteUsername,
  remotePassword: opts.remotePassword,
  remoteSetupToken: opts.remoteSetupToken,
  remoteMachineId: opts.remoteMachineId || deriveMachineId(opts.dir),
  remotePinnedRealmId: opts.remotePinnedRealmId,
  remotePinnedOpaqueServerPublicKey: opts.remotePinnedOpaqueServerKey,
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});

server.start().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Failed to start server: ${message}`);
  process.exit(1);
});
