import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCodexDeckConfigContent,
  updateCodexDeckConfigContent,
} from "../../web/codex-deck-config";

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
