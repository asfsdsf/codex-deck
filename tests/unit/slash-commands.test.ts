import assert from "node:assert/strict";
import test from "node:test";
import {
  getWorkflowComposerSlashCommands,
  getSlashPaletteCommands,
  parseSlashCommandInvocation,
  parseSlashCommandQuery,
  SESSION_COMPOSER_SLASH_COMMANDS,
  type SlashCommandDefinition,
} from "../../web/slash-commands";

test("diff command aliases preserve multiline prompts in session and bound composers", () => {
  const prompt = "--commit abc123\nExplain the API changes in Korean.";
  for (const commands of [
    SESSION_COMPOSER_SLASH_COMMANDS,
    getWorkflowComposerSlashCommands("bound-session"),
  ]) {
    for (const name of ["/ai-diff", "/codex-deck-diff"]) {
      const invocation = parseSlashCommandInvocation(
        `${name} ${prompt}`,
        commands,
      );
      assert.equal(invocation?.command.name, "/codex-deck-diff");
      assert.equal(invocation?.args, prompt);
      assert.equal(invocation?.command.supportsInlineArgs, true);
    }
    for (const query of ["/", "/ai", "/ai-diff"]) {
      const alias = getSlashPaletteCommands(query, commands).find(
        (command) => command.name === "/ai-diff",
      );
      assert.ok(alias, `/ai-diff should appear for ${query}`);
      assert.equal(alias.supportsInlineArgs, true);
    }
  }
  assert.equal(
    parseSlashCommandInvocation(
      "/ai-diff",
      getWorkflowComposerSlashCommands(null),
    ),
    null,
  );
});

test("parseSlashCommandQuery parses query and argument state", () => {
  assert.equal(parseSlashCommandQuery("hello"), null);
  assert.deepEqual(parseSlashCommandQuery("/"), {
    commandQuery: "",
    hasArguments: false,
  });
  assert.deepEqual(parseSlashCommandQuery("/re"), {
    commandQuery: "re",
    hasArguments: false,
  });
  assert.deepEqual(parseSlashCommandQuery("/review focus on tests"), {
    commandQuery: "review",
    hasArguments: true,
  });
});

test("getSlashPaletteCommands only returns visible matching commands", () => {
  const commands = getSlashPaletteCommands(
    "/re",
    SESSION_COMPOSER_SLASH_COMMANDS,
  );
  assert.deepEqual(
    commands.map((command) => command.name),
    ["/recap", "/rename", "/resume", "/review"],
  );

  const hiddenAlias = getSlashPaletteCommands(
    "/ap",
    SESSION_COMPOSER_SLASH_COMMANDS,
  );
  // The hidden `/approvals` alias stays out of the palette; `/apps` is real.
  assert.deepEqual(
    hiddenAlias.map((command) => command.name),
    ["/apps"],
  );

  const withArgs = getSlashPaletteCommands(
    "/review check diff",
    SESSION_COMPOSER_SLASH_COMMANDS,
  );
  assert.deepEqual(withArgs, []);

  const titleCommands = getSlashPaletteCommands(
    "/ti",
    SESSION_COMPOSER_SLASH_COMMANDS,
  );
  assert.deepEqual(
    titleCommands.map((command) => command.name),
    ["/title"],
  );

  const memoryCommands = getSlashPaletteCommands(
    "/mem",
    SESSION_COMPOSER_SLASH_COMMANDS,
  );
  assert.deepEqual(
    memoryCommands.map((command) => command.name),
    ["/memories"],
  );

  const hookCommands = getSlashPaletteCommands(
    "/ho",
    SESSION_COMPOSER_SLASH_COMMANDS,
  );
  assert.deepEqual(
    hookCommands.map((command) => command.name),
    ["/hooks"],
  );
});

test("parseSlashCommandInvocation resolves aliases and preserves args", () => {
  const commands: SlashCommandDefinition[] = [
    {
      name: "/exit",
      description: "Exit",
    },
    {
      name: "/quit",
      description: "Alias for /exit",
      hidden: true,
      aliasFor: "/exit",
    },
  ];

  const parsed = parseSlashCommandInvocation("/quit now", commands);
  assert.ok(parsed);
  assert.equal(parsed?.typedName, "/quit");
  assert.equal(parsed?.resolvedName, "/exit");
  assert.equal(parsed?.args, "now");
  assert.equal(parsed?.command.name, "/exit");
});

test("parseSlashCommandInvocation resolves /multi-agents to /agent", () => {
  const parsed = parseSlashCommandInvocation(
    "/multi-agents",
    SESSION_COMPOSER_SLASH_COMMANDS,
  );
  assert.ok(parsed);
  assert.equal(parsed?.resolvedName, "/agent");
  assert.equal(parsed?.command.name, "/agent");
});

test("parseSlashCommandInvocation resolves /btw to /side", () => {
  const parsed = parseSlashCommandInvocation(
    "/btw quick question",
    SESSION_COMPOSER_SLASH_COMMANDS,
  );
  assert.ok(parsed);
  assert.equal(parsed?.resolvedName, "/side");
  assert.equal(parsed?.command.name, "/side");
  assert.equal(parsed?.args, "quick question");
});

test("parseSlashCommandInvocation resolves /clean to /stop", () => {
  const parsed = parseSlashCommandInvocation(
    "/clean",
    SESSION_COMPOSER_SLASH_COMMANDS,
  );
  assert.ok(parsed);
  assert.equal(parsed?.resolvedName, "/stop");
  assert.equal(parsed?.command.name, "/stop");
});

test("parseSlashCommandInvocation resolves /approvals to /permissions", () => {
  const parsed = parseSlashCommandInvocation(
    "/approvals",
    SESSION_COMPOSER_SLASH_COMMANDS,
  );
  assert.ok(parsed);
  assert.equal(parsed?.resolvedName, "/permissions");
  assert.equal(parsed?.command.name, "/permissions");
});

test("parseSlashCommandInvocation resolves /pet to /pets", () => {
  const parsed = parseSlashCommandInvocation(
    "/pet hide",
    SESSION_COMPOSER_SLASH_COMMANDS,
  );
  assert.ok(parsed);
  assert.equal(parsed?.resolvedName, "/pets");
  assert.equal(parsed?.command.name, "/pets");
  assert.equal(parsed?.args, "hide");
});

test("parseSlashCommandInvocation returns null for unknown commands", () => {
  assert.equal(
    parseSlashCommandInvocation("/quit", SESSION_COMPOSER_SLASH_COMMANDS),
    null,
  );
  assert.equal(
    parseSlashCommandInvocation("/", SESSION_COMPOSER_SLASH_COMMANDS),
    null,
  );
});

test("session composer command list includes toolbar and mode controls", () => {
  const names = SESSION_COMPOSER_SLASH_COMMANDS.map((command) => command.name);
  assert.equal(names.includes("/model"), true);
  assert.equal(names.includes("/plan"), true);
  assert.equal(names.includes("/goal"), true);
  assert.equal(names.includes("/collab"), true);
  assert.equal(names.includes("/status"), true);
  assert.equal(names.includes("/title"), true);
  assert.equal(names.includes("/pets"), true);
  assert.equal(names.includes("/pet"), true);
  assert.equal(names.includes("/rename"), true);
  assert.equal(names.includes("/archive"), true);
  assert.equal(names.includes("/diff"), true);
  assert.equal(names.includes("/fork"), true);
  assert.equal(names.includes("/compact"), true);
  assert.equal(names.includes("/init"), true);
  assert.equal(names.includes("/agent"), true);
  assert.equal(names.includes("/side"), true);
  assert.equal(names.includes("/btw"), true);
  assert.equal(names.includes("/quit"), false);
  assert.equal(names.includes("/ps"), true);
  assert.equal(names.includes("/stop"), true);
  assert.equal(names.includes("/clean"), true);
  assert.equal(names.includes("/permissions"), true);
  assert.equal(names.includes("/memories"), true);
  assert.equal(names.includes("/hooks"), true);
  assert.equal(names.includes("/skills"), true);
  assert.equal(names.includes("/mention"), true);

  const planCommand = SESSION_COMPOSER_SLASH_COMMANDS.find(
    (command) => command.name === "/plan",
  );
  const goalCommand = SESSION_COMPOSER_SLASH_COMMANDS.find(
    (command) => command.name === "/goal",
  );
  const renameCommand = SESSION_COMPOSER_SLASH_COMMANDS.find(
    (command) => command.name === "/rename",
  );
  const resumeCommand = SESSION_COMPOSER_SLASH_COMMANDS.find(
    (command) => command.name === "/resume",
  );
  const sideCommand = SESSION_COMPOSER_SLASH_COMMANDS.find(
    (command) => command.name === "/side",
  );
  const petsCommand = SESSION_COMPOSER_SLASH_COMMANDS.find(
    (command) => command.name === "/pets",
  );
  assert.equal(planCommand?.supportsInlineArgs, true);
  assert.equal(goalCommand?.supportsInlineArgs, true);
  assert.equal(renameCommand?.supportsInlineArgs, true);
  assert.equal(resumeCommand?.supportsInlineArgs, true);
  assert.equal(sideCommand?.supportsInlineArgs, true);
  assert.equal(petsCommand?.supportsInlineArgs, true);
});

test("workflow composer command list matches session commands only when bound", () => {
  assert.deepEqual(getWorkflowComposerSlashCommands(null), []);
  assert.deepEqual(getWorkflowComposerSlashCommands(""), []);
  assert.deepEqual(getWorkflowComposerSlashCommands("   "), []);

  const boundCommands = getWorkflowComposerSlashCommands("session-123");
  assert.equal(boundCommands, SESSION_COMPOSER_SLASH_COMMANDS);
  assert.equal(
    boundCommands.map((command) => command.name).includes("/status"),
    true,
  );
  assert.equal(
    boundCommands.map((command) => command.name).includes("/review"),
    true,
  );
  assert.equal(
    boundCommands.map((command) => command.name).includes("/copy"),
    true,
  );
});
