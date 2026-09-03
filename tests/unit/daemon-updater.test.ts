import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createDaemonUpdaterOptionsFromEnvironment,
  DaemonUpdater,
  isVersionNewer,
  type RunDaemonUpdateCommand,
} from "../../api/daemon-updater";

test("compares stable and prerelease npm versions", () => {
  assert.equal(isVersionNewer("0.2.2", "0.2.1"), true);
  assert.equal(isVersionNewer("0.2.1", "0.2.1"), false);
  assert.equal(isVersionNewer("0.2.0", "0.2.1"), false);
  assert.equal(isVersionNewer("1.0.0", "1.0.0-beta.2"), true);
  assert.equal(isVersionNewer("1.0.0-beta.2", "1.0.0-beta.1"), true);
  assert.equal(isVersionNewer("1.0.0-beta", "1.0.0-beta.1"), false);
});

test("checks npm, installs a validated release, activates it, and schedules restart", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "codex-deck-update-test-"));
  const commands: Array<{ command: string; args: string[] }> = [];
  let restartCount = 0;
  const runCommand: RunDaemonUpdateCommand = async (command, args) => {
    commands.push({ command, args });
    if (args[0] === "view") {
      return { stdout: '"0.3.0"\n', stderr: "" };
    }
    const prefixIndex = args.indexOf("--prefix");
    assert.notEqual(prefixIndex, -1);
    const releaseRoot = args[prefixIndex + 1];
    const packageRoot = join(releaseRoot, "node_modules", "codex-deck");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "codex-deck", version: "0.3.0" }),
      "utf-8",
    );
    await writeFile(join(packageRoot, "dist", "index.js"), "", "utf-8");
    return { stdout: "installed", stderr: "" };
  };
  const updater = new DaemonUpdater({
    currentVersion: "0.2.1",
    managed: true,
    stateDir,
    commandPath: join(stateDir, "codex-deck-daemon"),
    startDirectory: "/started/from/here",
    runCommand,
    scheduleRestart: () => {
      restartCount += 1;
    },
    now: () => new Date("2026-08-27T00:00:00.000Z"),
  });

  try {
    const checked = await updater.checkNpm();
    assert.equal(checked.npm.latestVersion, "0.3.0");
    assert.equal(checked.npm.updateAvailable, true);
    assert.equal(checked.sourceRoot, "/started/from/here");

    const response = await updater.update({ method: "npm" });
    assert.equal(response.installedVersion, "0.3.0");
    assert.equal(response.sourceRoot, null);
    assert.equal(restartCount, 1);
    assert.equal(commands.filter(({ args }) => args[0] === "view").length, 2);
    assert.match(
      await readFile(join(stateDir, "active-project-root"), "utf-8"),
      /releases\/npm-0\.3\.0-.+\/node_modules\/codex-deck\n$/,
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(join(stateDir, "update-settings.json"), "utf-8"),
      ),
      { method: "npm", sourceRoot: "/started/from/here" },
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("builds a selected source project before activating it", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-source-update-test-"));
  const stateDir = join(root, "state");
  const sourceRoot = join(root, "source");
  const commands: string[][] = [];
  let restartCount = 0;
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(
    join(sourceRoot, "package.json"),
    JSON.stringify({
      name: "codex-deck",
      version: "0.2.5",
      scripts: { build: "build" },
    }),
    "utf-8",
  );
  const realSourceRoot = await realpath(sourceRoot);
  const runCommand: RunDaemonUpdateCommand = async (_command, args) => {
    commands.push(args);
    if (args.at(-1) === "build") {
      await mkdir(join(realSourceRoot, "dist"), { recursive: true });
      await writeFile(join(realSourceRoot, "dist", "index.js"), "", "utf-8");
    }
    return { stdout: "", stderr: "" };
  };
  const updater = new DaemonUpdater({
    currentVersion: "0.2.1",
    managed: true,
    stateDir,
    commandPath: join(root, "codex-deck-daemon"),
    startDirectory: join(root, "start-directory"),
    runCommand,
    scheduleRestart: () => {
      restartCount += 1;
    },
  });

  try {
    const response = await updater.update({
      method: "source",
      sourceRoot,
    });
    assert.equal(response.installedVersion, "0.2.5");
    assert.equal(response.sourceRoot, realSourceRoot);
    assert.equal(restartCount, 1);
    assert.deepEqual(commands, [
      ["--dir", realSourceRoot, "install", "--frozen-lockfile"],
      ["--dir", realSourceRoot, "build"],
    ]);
    assert.equal(
      await readFile(join(stateDir, "active-project-root"), "utf-8"),
      `${realSourceRoot}\n`,
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(join(stateDir, "update-settings.json"), "utf-8"),
      ),
      { method: "source", sourceRoot: realSourceRoot },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses live updates outside a managed daemon", async () => {
  const updater = new DaemonUpdater({
    currentVersion: "0.2.1",
    managed: false,
    startDirectory: process.cwd(),
  });
  const status = await updater.getStatus();
  assert.equal(status.daemonManaged, false);
  assert.equal(status.restartSupported, false);
  await assert.rejects(
    updater.update({ method: "source", sourceRoot: process.cwd() }),
    /available only when codex-deck is running through codex-deck-daemon/,
  );
});

test("detects an older daemon runner at the standard XDG paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-legacy-update-test-"));
  const stateHome = join(root, "state");
  const binHome = join(root, "bin");
  const previousNodeEnv = process.env.NODE_ENV;
  const previousStateHome = process.env.XDG_STATE_HOME;
  const previousBinHome = process.env.XDG_BIN_HOME;
  const previousManaged = process.env.CODEX_DECK_DAEMON_MANAGED;
  const previousStateDir = process.env.CODEX_DECK_DAEMON_STATE_DIR;
  const previousCommandPath = process.env.CODEX_DECK_DAEMON_COMMAND_PATH;
  const noOpenArgumentIndex = process.argv.length;
  try {
    await mkdir(join(stateHome, "codex-deck"), { recursive: true });
    await mkdir(binHome, { recursive: true });
    await writeFile(
      join(stateHome, "codex-deck", "run-server.sh"),
      `exec node ${resolve(process.argv[1])} --no-open\n`,
    );
    await writeFile(join(binHome, "codex-deck-daemon"), "");
    process.env.NODE_ENV = "production";
    process.env.XDG_STATE_HOME = stateHome;
    process.env.XDG_BIN_HOME = binHome;
    delete process.env.CODEX_DECK_DAEMON_MANAGED;
    delete process.env.CODEX_DECK_DAEMON_STATE_DIR;
    delete process.env.CODEX_DECK_DAEMON_COMMAND_PATH;
    process.argv.push("--no-open");

    const options = createDaemonUpdaterOptionsFromEnvironment("0.2.1");
    assert.equal(options.managed, true);
    assert.equal(options.stateDir, join(stateHome, "codex-deck"));
    assert.equal(options.commandPath, join(binHome, "codex-deck-daemon"));
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    if (previousBinHome === undefined) delete process.env.XDG_BIN_HOME;
    else process.env.XDG_BIN_HOME = previousBinHome;
    if (previousManaged === undefined)
      delete process.env.CODEX_DECK_DAEMON_MANAGED;
    else process.env.CODEX_DECK_DAEMON_MANAGED = previousManaged;
    if (previousStateDir === undefined)
      delete process.env.CODEX_DECK_DAEMON_STATE_DIR;
    else process.env.CODEX_DECK_DAEMON_STATE_DIR = previousStateDir;
    if (previousCommandPath === undefined)
      delete process.env.CODEX_DECK_DAEMON_COMMAND_PATH;
    else process.env.CODEX_DECK_DAEMON_COMMAND_PATH = previousCommandPath;
    process.argv.splice(noOpenArgumentIndex);
    await rm(root, { recursive: true, force: true });
  }
});
