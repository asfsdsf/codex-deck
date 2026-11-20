import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCodexDeckConfigFormChanges,
  parseCodexDeckConfigContent,
  readCodexDeckConfigForm,
  updateCodexDeckConfigContent,
} from "../../web/codex-deck-config";

test("settings form shows effective file values, including overrides and explicit false", () => {
  const form = readCodexDeckConfigForm({
    path: "/home/codex-deck/config.toml",
    content: 'port = 13000\nopen = true\n[remote]\nusername = "home-user"\n',
    revision: "revision",
    effectiveConfig: {
      port: 14000,
      dir: "/configured/home",
      dev: false,
      open: false,
      translationCommand: "printf local",
      remote: { username: "local-user", password: "inherited-password" },
      conversationHover: { model: true, timestamp: false },
      codexHomes: { work: { path: "/work", label: "Work" } },
    },
  });
  assert.equal(form.port, "14000");
  assert.equal(form.dir, "/configured/home");
  assert.equal(form.dev, false);
  assert.equal(form.open, false);
  assert.equal(form.translationCommand, "printf local");
  assert.equal(form.remote.username, "local-user");
  assert.equal(form.remote.password, "inherited-password");
  assert.deepEqual(form.conversationHover, { model: true, timestamp: false });
  assert.deepEqual(form.codexHomes, [
    { id: "work", label: "Work", path: "/work" },
  ]);
});

test("structured edits save only changed fields without copying inherited settings", () => {
  const content =
    '# keep\nopen = true\n[remote]\nusername = "home-user"\n[conversation_hover]\nmodel = false\n';
  const effective = parseCodexDeckConfigContent(
    'port = 14000\nopen = false\ntranslation_command = "printf local"\n[remote]\nusername = "local-user"\npassword = "local-password"\n[conversation_hover]\nmodel = true\n[codex_homes.work]\npath = "/work"\nlabel = "Work"\n',
  );
  const next = {
    ...effective,
    dev: true,
    remote: { ...effective.remote, machineId: "new-machine" },
    conversationHover: { ...effective.conversationHover, timestamp: false },
  };
  const fileConfig = applyCodexDeckConfigFormChanges(
    parseCodexDeckConfigContent(content),
    effective,
    next,
  );
  const updated = updateCodexDeckConfigContent(content, fileConfig);
  assert.match(updated, /^# keep/m);
  assert.match(updated, /dev = true/);
  assert.match(updated, /open = true/);
  assert.match(updated, /username = "home-user"/);
  assert.match(updated, /machine_id = "new-machine"/);
  assert.match(updated, /model = false/);
  assert.match(updated, /timestamp = false/);
  assert.doesNotMatch(
    updated,
    /port =|translation_command =|password =|codex_homes/,
  );
  assert.deepEqual(effective.conversationHover, { model: true });
});

test("TOML edits preserve inherited form values and clear removed fields", () => {
  const content = 'dev = true\n[remote]\nmachine_id = "old-machine"\n';
  const form = parseCodexDeckConfigContent(
    'port = 14000\ndev = true\n[remote]\nusername = "inherited-user"\nmachine_id = "old-machine"\n',
  );
  const updated = applyCodexDeckConfigFormChanges(
    form,
    parseCodexDeckConfigContent(content),
    parseCodexDeckConfigContent(
      'open = false\n[remote]\nmachine_id = "new-machine"\n',
    ),
  );
  assert.equal(updated.port, "14000");
  assert.equal(updated.dev, null);
  assert.equal(updated.open, false);
  assert.equal(updated.remote.username, "inherited-user");
  assert.equal(updated.remote.machineId, "new-machine");
});

test("home edits preserve inherited fields and support adding, renaming, and removing homes", () => {
  const base = parseCodexDeckConfigContent(
    '[codex_homes.work]\nlabel = "Old"\n',
  );
  const previous = parseCodexDeckConfigContent(
    '[codex_homes.work]\npath = "/work"\nlabel = "Old"\n',
  );
  const next = {
    ...previous,
    codexHomes: [{ id: "work", path: "/work", label: "New" }],
  };
  const edited = applyCodexDeckConfigFormChanges(base, previous, next);
  assert.deepEqual(edited.codexHomes, [{ id: "work", path: "", label: "New" }]);
  const renamed = applyCodexDeckConfigFormChanges(edited, next, {
    ...next,
    codexHomes: [{ ...next.codexHomes[0]!, id: "renamed" }],
  });
  assert.deepEqual(renamed.codexHomes, [
    { id: "renamed", path: "/work", label: "New" },
  ]);
  const removed = applyCodexDeckConfigFormChanges(renamed, renamed, {
    ...renamed,
    codexHomes: [],
  });
  assert.deepEqual(removed.codexHomes, []);
});

test("settings form falls back to file content when effective settings are unavailable", () => {
  const content = "port = 13000\nopen = false\n";
  assert.deepEqual(
    readCodexDeckConfigForm({
      path: "/config.toml",
      content,
      revision: "revision",
    }),
    parseCodexDeckConfigContent(content),
  );
});

test("config editor parses every supported Codex Deck setting", () => {
  const parsed = parseCodexDeckConfigContent(
    [
      "port = 13000",
      'dir = "/data/main"',
      "dev = true",
      "open = false",
      'translation_command = "translate $PROMPT"',
      "",
      "[codex_homes.work]",
      'path = "/data/work"',
      'label = "Work"',
      "",
      "[remote]",
      'server_url = "https://deck.example.com"',
      'username = "alice"',
      'password = "s3\\"cret"',
      'setup_token = "token"',
      'machine_id = "machine-1"',
      'pinned_realm_id = "realm-1"',
      'pinned_opaque_server_key = "public-key"',
    ].join("\n"),
  );

  assert.deepEqual(parsed, {
    port: "13000",
    dir: "/data/main",
    dev: true,
    open: false,
    translationCommand: "translate $PROMPT",
    conversationHover: {},
    codexHomes: [{ id: "work", path: "/data/work", label: "Work" }],
    remote: {
      serverUrl: "https://deck.example.com",
      username: "alice",
      password: 's3"cret',
      setupToken: "token",
      machineId: "machine-1",
      pinnedRealmId: "realm-1",
      pinnedOpaqueServerKey: "public-key",
    },
  });
});

test("floating tip controls round-trip false values and preserve unknown TOML", () => {
  const original =
    '# keep\n[conversation_hover]\nenabled = true\nmodel = false\nfuture_field = true\n\n[remote]\nusername = "alice"\n';
  const config = parseCodexDeckConfigContent(original);
  config.conversationHover = { enabled: false, model: true, timestamp: false };
  const updated = updateCodexDeckConfigContent(original, config);
  assert.deepEqual(
    parseCodexDeckConfigContent(updated).conversationHover,
    config.conversationHover,
  );
  assert.match(updated, /future_field = true/);
  assert.match(updated, /username = "alice"/);
  config.conversationHover = {};
  const reset = updateCodexDeckConfigContent(updated, config);
  assert.deepEqual(parseCodexDeckConfigContent(reset).conversationHover, {});
  assert.doesNotMatch(reset, /(?:enabled|model|timestamp) =/);
  assert.match(reset, /future_field = true/);
});

test("structured config edits preserve comments and unrelated tables", () => {
  const original = [
    "# keep this comment",
    "port = 12001",
    'translation_command = "old command"',
    "",
    "[unrelated]",
    'custom = "keep me"',
    "",
    "[codex_homes.unknown.nested]",
    'custom = "keep nested table"',
    "",
    "[remote]",
    'username = "old-user"',
    'password = "remove-me"',
  ].join("\n");
  const config = parseCodexDeckConfigContent(original);
  config.port = "14000";
  config.translationCommand = "new \\ command\nnext";
  config.remote.username = "new-user";
  config.remote.password = "";

  const updated = updateCodexDeckConfigContent(original, config);

  assert.match(updated, /^# keep this comment/m);
  assert.match(updated, /port = 14000/);
  assert.match(updated, /translation_command = "new \\\\ command\\nnext"/);
  assert.match(updated, /\[unrelated\]\ncustom = "keep me"/);
  assert.match(
    updated,
    /\[codex_homes\.unknown\.nested\]\ncustom = "keep nested table"/,
  );
  assert.match(updated, /\[remote\]\nusername = "new-user"/);
  assert.doesNotMatch(updated, /remove-me|password\s*=/);
  assert.deepEqual(parseCodexDeckConfigContent(updated), config);
});

test("structured config edits add, update, and remove Codex homes", () => {
  const original = [
    "[codex_homes.work]",
    'path = "/old/work"',
    'label = "Old work"',
    "",
    "[codex_homes.remove]",
    'path = "/remove"',
  ].join("\n");
  const config = parseCodexDeckConfigContent(original);
  config.codexHomes = [
    { id: "work", path: "/new/work", label: "Work" },
    { id: "personal", path: "/data/personal", label: "Personal" },
  ];

  const updated = updateCodexDeckConfigContent(original, config);

  assert.match(updated, /\[codex_homes\.work\]\npath = "\/new\/work"/);
  assert.match(updated, /label = "Work"/);
  assert.doesNotMatch(updated, /codex_homes\.remove/);
  assert.match(
    updated,
    /\[codex_homes\.personal\]\npath = "\/data\/personal"\nlabel = "Personal"/,
  );
});
