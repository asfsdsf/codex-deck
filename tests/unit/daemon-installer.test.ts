import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const installerPath = join(repositoryRoot, "scripts/install-daemon.sh");

async function runInstaller(
  home: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(installerPath, args, {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: "",
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      ...extraEnv,
    },
  });
}

test("generates a launchd service and lifecycle command without starting it", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-deck-daemon-test-"));
  const fakeBin = join(home, "fake-bin");
  try {
    const binDir = join(home, "bin");
    await mkdir(fakeBin, { recursive: true });
    const fakeLaunchctl = join(fakeBin, "launchctl");
    await writeFile(
      fakeLaunchctl,
      '#!/bin/sh\n[ "$1" = print ] && exit 1\nexit 0\n',
      "utf8",
    );
    await chmod(fakeLaunchctl, 0o755);
    const testPath = `${fakeBin}:${process.env.PATH ?? ""}`;
    await runInstaller(
      home,
      [
        "install",
        "--service-manager",
        "launchd",
        "--bin-dir",
        binDir,
        "--no-build",
      ],
      { PATH: testPath },
    );

    const runnerPath = join(
      home,
      ".local",
      "state",
      "codex-deck",
      "run-server.sh",
    );
    const plistPath = join(
      home,
      "Library",
      "LaunchAgents",
      "com.codex-deck.server.plist",
    );
    const commandPath = join(binDir, "codex-deck-daemon");
    const runner = await readFile(runnerPath, "utf8");
    const plist = await readFile(plistPath, "utf8");

    assert.match(runner, /dist\/index\.js' --no-open/);
    assert.match(plist, /com\.codex-deck\.server/);
    assert.match(plist, /run-server\.sh/);
    await execFileAsync("bash", ["-n", runnerPath]);
    await execFileAsync("bash", ["-n", commandPath]);

    const status = await execFileAsync(commandPath, ["status"], {
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: "",
        PATH: testPath,
      },
    });
    assert.match(
      status.stdout,
      /com\.codex-deck\.server - Codex Deck web server/,
    );
    assert.match(status.stdout, /Loaded: loaded/);
    assert.match(
      status.stdout,
      /Active: inactive \(stopped; launchd job is not loaded\)/,
    );
    assert.ok(
      status.stdout.includes(
        `Config: ${join(home, ".codex", "codex-deck", "config.toml")}`,
      ),
    );
    assert.match(status.stdout, /Logs: .*\/server\.log/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("reinstalling a loaded launchd service stops it without starting it again", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-deck-daemon-test-"));
  const fakeBin = join(home, "fake-bin");
  try {
    const launchAgentsDir = join(home, "Library", "LaunchAgents");
    const callsPath = join(home, "launchctl-calls.log");
    const loadedPath = join(home, "launchctl-loaded");
    await mkdir(fakeBin, { recursive: true });
    await mkdir(launchAgentsDir, { recursive: true });
    await writeFile(
      join(launchAgentsDir, "com.codex-deck.server.plist"),
      "existing service",
      "utf8",
    );
    await writeFile(loadedPath, "loaded\n", "utf8");
    const fakeLaunchctl = join(fakeBin, "launchctl");
    await writeFile(
      fakeLaunchctl,
      [
        "#!/bin/sh",
        `printf '%s\\n' \"$*\" >> '${callsPath}'`,
        `if [ \"$1\" = print ]; then [ -f '${loadedPath}' ]; exit $?; fi`,
        `if [ \"$1\" = bootout ]; then rm -f '${loadedPath}'; fi`,
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeLaunchctl, 0o755);

    await runInstaller(
      home,
      ["install", "--service-manager", "launchd", "--no-build"],
      { PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    );

    const calls = await readFile(callsPath, "utf8");
    assert.match(calls, /bootout gui\/\d+\/com\.codex-deck\.server/);
    assert.doesNotMatch(calls, /bootstrap|kickstart/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("launchd status renders a readable service summary", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-deck-daemon-test-"));
  const fakeBin = join(home, "fake-bin");
  try {
    const launchAgentsDir = join(home, "Library", "LaunchAgents");
    await mkdir(fakeBin, { recursive: true });
    await mkdir(launchAgentsDir, { recursive: true });
    await writeFile(
      join(launchAgentsDir, "com.codex-deck.server.plist"),
      "existing service",
      "utf8",
    );
    const fakeLaunchctl = join(fakeBin, "launchctl");
    await writeFile(
      fakeLaunchctl,
      [
        "#!/bin/sh",
        'if [ "$1" = print ]; then',
        "  cat <<'STATUS'",
        "state = running",
        "pid = 12345",
        "path = /tmp/com.codex-deck.server.plist",
        "type = LaunchAgent",
        "program = /tmp/run-server.sh",
        "working directory = /tmp/codex-deck",
        "stdout path = /tmp/server.log",
        "stderr path = /tmp/server.log",
        "last exit code = 0",
        "STATUS",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeLaunchctl, 0o755);

    await runInstaller(
      home,
      ["install", "--service-manager", "launchd", "--no-build"],
      { PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    );
    const status = await execFileAsync(
      join(home, ".local", "bin", "codex-deck-daemon"),
      ["status"],
      {
        env: {
          ...process.env,
          HOME: home,
          CODEX_HOME: "",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      },
    );

    assert.match(
      status.stdout,
      /com\.codex-deck\.server - Codex Deck web server/,
    );
    assert.match(
      status.stdout,
      /Loaded: loaded \(\/tmp\/com\.codex-deck\.server\.plist\)/,
    );
    assert.match(status.stdout, /Active: active \(running\)/);
    assert.match(status.stdout, /PID: 12345/);
    assert.match(status.stdout, /Program: \/tmp\/run-server\.sh/);
    assert.match(status.stdout, /Logs: \/tmp\/server\.log/);
    assert.ok(
      status.stdout.includes(
        `Config: ${join(home, ".codex", "codex-deck", "config.toml")}`,
      ),
    );
    assert.match(status.stdout, /Last Exit: 0/);
    assert.doesNotMatch(status.stdout, /state = running/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status uses the configured main Codex home for the config path", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-deck-daemon-test-"));
  const fakeBin = join(home, "fake-bin");
  const projectRoot = join(home, "project");
  const configuredHome = join(home, "configured-codex-home");
  try {
    const launchAgentsDir = join(home, "Library", "LaunchAgents");
    await mkdir(fakeBin, { recursive: true });
    await mkdir(launchAgentsDir, { recursive: true });
    await mkdir(join(projectRoot, "dist"), { recursive: true });
    await writeFile(join(projectRoot, "package.json"), "{}\n", "utf8");
    await writeFile(join(projectRoot, "dist", "index.js"), "", "utf8");
    await writeFile(
      join(projectRoot, "config.toml"),
      `dir = "${configuredHome}"\n`,
      "utf8",
    );
    await writeFile(
      join(launchAgentsDir, "com.codex-deck.server.plist"),
      "existing service",
      "utf8",
    );
    const fakeLaunchctl = join(fakeBin, "launchctl");
    await writeFile(
      fakeLaunchctl,
      '#!/bin/sh\n[ "$1" = print ] && exit 1\nexit 0\n',
      "utf8",
    );
    await chmod(fakeLaunchctl, 0o755);

    await runInstaller(
      home,
      [
        "install",
        "--project-root",
        projectRoot,
        "--service-manager",
        "launchd",
        "--no-build",
      ],
      { PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    );
    const status = await runInstaller(
      home,
      ["status", "--service-manager", "launchd"],
      {
        CODEX_DECK_DAEMON_PROJECT_ROOT: projectRoot,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    );

    assert.ok(
      status.stdout.includes(
        `Config: ${join(configuredHome, "codex-deck", "config.toml")}`,
      ),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status uses CODEX_HOME from the daemon environment file", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-deck-daemon-test-"));
  const fakeBin = join(home, "fake-bin");
  const envFile = join(home, "server.env");
  const envCodexHome = join(home, "env-codex-home");
  try {
    const launchAgentsDir = join(home, "Library", "LaunchAgents");
    await mkdir(fakeBin, { recursive: true });
    await mkdir(launchAgentsDir, { recursive: true });
    await writeFile(envFile, `CODEX_HOME="${envCodexHome}"\n`, "utf8");
    await writeFile(
      join(launchAgentsDir, "com.codex-deck.server.plist"),
      "existing service",
      "utf8",
    );
    const fakeLaunchctl = join(fakeBin, "launchctl");
    await writeFile(
      fakeLaunchctl,
      '#!/bin/sh\n[ "$1" = print ] && exit 1\nexit 0\n',
      "utf8",
    );
    await chmod(fakeLaunchctl, 0o755);

    await runInstaller(
      home,
      [
        "install",
        "--service-manager",
        "launchd",
        "--env-file",
        envFile,
        "--no-build",
      ],
      { PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    );
    const status = await execFileAsync(
      join(home, ".local", "bin", "codex-deck-daemon"),
      ["status"],
      {
        env: {
          ...process.env,
          HOME: home,
          CODEX_HOME: "",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      },
    );
    assert.ok(
      status.stdout.includes(
        `Config: ${join(envCodexHome, "codex-deck", "config.toml")}`,
      ),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("generates a systemd user unit", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-deck-daemon-test-"));
  const fakeBin = join(home, "fake-bin");
  try {
    await mkdir(fakeBin, { recursive: true });
    const fakeSystemctl = join(fakeBin, "systemctl");
    await writeFile(fakeSystemctl, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(fakeSystemctl, 0o755);

    await runInstaller(
      home,
      ["install", "--service-manager", "systemd", "--no-build"],
      {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    );

    const unitPath = join(
      home,
      ".config",
      "systemd",
      "user",
      "codex-deck.service",
    );
    const unit = await readFile(unitPath, "utf8");
    assert.match(unit, /ExecStart=.*run-server\.sh/);
    assert.match(unit, /Restart=on-failure/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("systemd status reports an installed inactive service as stopped", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-deck-daemon-test-"));
  const fakeBin = join(home, "fake-bin");
  try {
    await mkdir(fakeBin, { recursive: true });
    const fakeSystemctl = join(fakeBin, "systemctl");
    await writeFile(
      fakeSystemctl,
      [
        "#!/bin/sh",
        '[ "$2" = status ] && {',
        '  printf "%s\\n" "codex-deck.service - Codex Deck web server" "     Loaded: loaded" "     Active: inactive (dead)"',
        "  exit 3",
        "}",
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeSystemctl, 0o755);
    const testPath = `${fakeBin}:${process.env.PATH ?? ""}`;

    await runInstaller(
      home,
      ["install", "--service-manager", "systemd", "--no-build"],
      { PATH: testPath },
    );
    const status = await runInstaller(
      home,
      ["status", "--service-manager", "systemd"],
      {
        PATH: testPath,
      },
    );
    assert.match(status.stdout, /codex-deck\.service - Codex Deck web server/);
    assert.match(status.stdout, /Active: inactive \(dead\)/);
    assert.ok(
      status.stdout.includes(
        `Config: ${join(home, ".codex", "codex-deck", "config.toml")}`,
      ),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
