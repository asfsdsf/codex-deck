import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findConfigFiles,
  loadCodexDeckConfig,
  mergeCodexDeckConfigs,
  parseConfigToml,
  resolveCodexDeckOptions,
} from "../../api/config";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "codex-deck-config-test-"));
}

test("parseConfigToml parses top-level values and the remote table", () => {
  const config = parseConfigToml(
    [
      "# codex-deck config",
      "port = 13000 # trailing content is tolerated",
      'dir = "/data/codex home"',
      "dev = true",
      "open = false",
      "",
      "[remote]",
      'server_url = "https://deck.example.com"',
      'username = "alice"',
      'password = "s3\\"cret"',
      'setup_token = "tok\\n123"',
      'machine_id = "machine-1"',
      'pinned_realm_id = "realm-1"',
      'pinned_opaque_server_key = "key-1"',
    ].join("\n"),
  );

  assert.equal(config.port, 13000);
  assert.equal(config.dir, "/data/codex home");
  assert.equal(config.dev, true);
  assert.equal(config.open, false);
  assert.deepEqual(config.remote, {
    serverUrl: "https://deck.example.com",
    username: "alice",
    password: 's3"cret',
    setupToken: "tok\n123",
    machineId: "machine-1",
    pinnedRealmId: "realm-1",
    pinnedOpaqueServerKey: "key-1",
  });
});

test("parseConfigToml ignores unknown keys, tables, and malformed lines", () => {
  const config = parseConfigToml(
    [
      "port = 13000",
      "unknown_key = 42",
      "not-a-key-value-line",
      "dir = /missing/quotes",
      "",
      "[unrelated]",
      'server_url = "https://wrong-table.example.com"',
      "port = 9999",
      "",
      "[remote]",
      "unknown_remote_key = 1",
      "username = 42",
    ].join("\n"),
  );

  assert.equal(config.port, 13000);
  assert.equal(config.dir, undefined);
  assert.equal(config.remote, undefined);
});

test("parseConfigToml rejects out-of-range and non-integer ports", () => {
  assert.equal(parseConfigToml("port = 0").port, undefined);
  assert.equal(parseConfigToml("port = 70000").port, undefined);
  assert.equal(parseConfigToml('port = "abc"').port, undefined);
  assert.equal(parseConfigToml("port = -5").port, undefined);
});

test("findConfigFiles returns existing files in priority order", () => {
  const root = makeTempDir();
  const cwd = join(root, "project");
  const codexHome = join(root, "codex-home");
  mkdirSync(join(codexHome, "codex-deck"), { recursive: true });
  mkdirSync(cwd, { recursive: true });

  const homeConfig = join(codexHome, "codex-deck", "config.toml");
  writeFileSync(homeConfig, "port = 13001\n");
  assert.deepEqual(findConfigFiles(cwd, codexHome), [homeConfig]);

  const localConfig = join(cwd, "config.toml");
  writeFileSync(localConfig, "port = 13000\n");
  assert.deepEqual(findConfigFiles(cwd, codexHome), [localConfig, homeConfig]);
});

test("findConfigFiles returns an empty list when no config file exists", () => {
  const root = makeTempDir();
  assert.deepEqual(findConfigFiles(join(root, "cwd"), join(root, "home")), []);
});

test("loadCodexDeckConfig reads and parses the discovered file", () => {
  const root = makeTempDir();
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "config.toml"), 'port = 14000\ndir = "/x/y"\n');

  const { paths, config } = loadCodexDeckConfig(cwd, join(root, "home"));
  assert.deepEqual(paths, [join(cwd, "config.toml")]);
  assert.equal(config.port, 14000);
  assert.equal(config.dir, "/x/y");
});

test("loadCodexDeckConfig merges both files per key, local file winning", () => {
  const root = makeTempDir();
  const cwd = join(root, "project");
  const codexHome = join(root, "codex-home");
  mkdirSync(join(codexHome, "codex-deck"), { recursive: true });
  mkdirSync(cwd, { recursive: true });

  writeFileSync(
    join(codexHome, "codex-deck", "config.toml"),
    [
      "port = 13001",
      'dir = "/from/home"',
      "open = false",
      "",
      "[remote]",
      'username = "home-user"',
      'password = "home-pass"',
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "config.toml"),
    ["port = 13000", "", "[remote]", 'username = "local-user"'].join("\n"),
  );

  const { paths, config } = loadCodexDeckConfig(cwd, codexHome);
  assert.equal(paths.length, 2);
  // Set in both files: ./config.toml wins.
  assert.equal(config.port, 13000);
  assert.equal(config.remote?.username, "local-user");
  // Only set in the codex home file: still applies.
  assert.equal(config.dir, "/from/home");
  assert.equal(config.open, false);
  assert.equal(config.remote?.password, "home-pass");
});

test("mergeCodexDeckConfigs keeps remote undefined when neither file sets it", () => {
  assert.deepEqual(mergeCodexDeckConfigs({ port: 1 }, { dir: "/x" }), {
    port: 1,
    dir: "/x",
  });
});

test("resolveCodexDeckOptions applies built-in defaults", () => {
  const opts = resolveCodexDeckOptions({}, {}, { CODEX_HOME: "/codex" });
  assert.equal(opts.port, 12001);
  assert.equal(opts.dir, "/codex");
  assert.equal(opts.dev, false);
  assert.equal(opts.open, true);
  assert.equal(opts.remoteServerUrl, undefined);
});

test("resolveCodexDeckOptions prioritizes CLI > config file > defaults", () => {
  const config = parseConfigToml(
    ["port = 13000", 'dir = "/from/config"', "dev = true", "open = false"].join(
      "\n",
    ),
  );

  const fromConfig = resolveCodexDeckOptions({}, config, {});
  assert.equal(fromConfig.port, 13000);
  assert.equal(fromConfig.dir, "/from/config");
  assert.equal(fromConfig.dev, true);
  assert.equal(fromConfig.open, false);

  const fromCli = resolveCodexDeckOptions(
    { port: "14000", dir: "/from/cli", dev: false, open: true },
    config,
    {},
  );
  assert.equal(fromCli.port, 14000);
  assert.equal(fromCli.dir, "/from/cli");
  assert.equal(fromCli.dev, false);
  assert.equal(fromCli.open, true);
});

test("resolveCodexDeckOptions falls back to the default port for invalid values", () => {
  assert.equal(resolveCodexDeckOptions({ port: "abc" }, {}, {}).port, 12001);
  assert.equal(resolveCodexDeckOptions({ port: "0" }, {}, {}).port, 12001);
});

test("resolveCodexDeckOptions prioritizes CLI > env > config for remote options", () => {
  const config = parseConfigToml(
    [
      "[remote]",
      'server_url = "https://from-config.example.com"',
      'username = "config-user"',
      'password = "config-pass"',
      'setup_token = "config-token"',
      'machine_id = "config-machine"',
    ].join("\n"),
  );

  const fromConfig = resolveCodexDeckOptions({}, config, {});
  assert.equal(fromConfig.remoteServerUrl, "https://from-config.example.com");
  assert.equal(fromConfig.remoteUsername, "config-user");
  assert.equal(fromConfig.remotePassword, "config-pass");
  assert.equal(fromConfig.remoteSetupToken, "config-token");
  assert.equal(fromConfig.remoteMachineId, "config-machine");

  const env = {
    CODEXDECK_REMOTE_SERVER_URL: "https://from-env.example.com",
    CODEXDECK_REMOTE_USERNAME: "env-user",
  };
  const fromEnv = resolveCodexDeckOptions({}, config, env);
  assert.equal(fromEnv.remoteServerUrl, "https://from-env.example.com");
  assert.equal(fromEnv.remoteUsername, "env-user");
  assert.equal(fromEnv.remotePassword, "config-pass");

  const fromCli = resolveCodexDeckOptions(
    { remoteServerUrl: "https://from-cli.example.com" },
    config,
    env,
  );
  assert.equal(fromCli.remoteServerUrl, "https://from-cli.example.com");
  assert.equal(fromCli.remoteUsername, "env-user");
});
