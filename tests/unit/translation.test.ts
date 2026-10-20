import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandTranslationCommand,
  setMacOSTranslationBackendForTests,
  translateText,
  TranslationUnavailableError,
} from "../../api/translation";

test("expandTranslationCommand substitutes shell-escaped values", () => {
  const expanded = expandTranslationCommand(
    "translate_cmd $PROMPT $INPUT_LANG $OUTPUT_LANG",
    { prompt: "hello world", inputLang: "en", outputLang: "zh" },
  );
  assert.equal(expanded, "translate_cmd 'hello world' 'en' 'zh'");
});

test("expandTranslationCommand escapes single quotes and supports ${} forms", () => {
  const expanded = expandTranslationCommand(
    "cmd ${PROMPT} ${INPUT_LANG} ${OUTPUT_LANG}",
    { prompt: "it's a test", inputLang: "en", outputLang: "zh" },
  );
  assert.equal(expanded, "cmd 'it'\\''s a test' 'en' 'zh'");
});

test("translateText runs the configured command and returns stdout", async () => {
  const translated = await translateText({
    text: "hello world",
    inputLang: "en",
    outputLang: "zh",
    command: "printf '%s' $PROMPT",
    platform: "linux",
  });
  assert.equal(translated, "hello world");
});

test(
  "translateText publishes accumulated stdout before the command exits",
  { timeout: 5000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "translation-stream-"));
    const gate = join(directory, "continue");
    t.after(() => rm(directory, { recursive: true, force: true }));
    const chunks: string[] = [];
    let first!: () => void;
    const received = new Promise<void>((resolve) => {
      first = resolve;
    });
    let finished = false;
    const result = translateText({
      text: gate,
      inputLang: "en",
      outputLang: "zh",
      command:
        "printf '你好'; while [ ! -f $PROMPT ]; do sleep 0.01; done; printf '世界\\n'",
      onProgress: (text) => {
        chunks.push(text);
        first();
      },
    }).then((text) => {
      finished = true;
      return text;
    });
    try {
      await received;
      assert.equal(finished, false);
      assert.equal(chunks[0], "你好");
    } finally {
      await writeFile(gate, "");
    }
    assert.equal(await result, "你好世界");
    assert.equal(chunks.at(-1), "你好世界\n");
  },
);

test("translateText preserves spaces, quotes, and newlines in the prompt", async () => {
  const text = 'it\'s a "test"\nwith a second line  and  spaces';
  const translated = await translateText({
    text,
    inputLang: "en",
    outputLang: "zh",
    command: "printf '%s' $PROMPT",
    platform: "linux",
  });
  assert.equal(translated, text);
});

test("translateText substitutes input and output languages", async () => {
  const translated = await translateText({
    text: "ignored",
    inputLang: "en",
    outputLang: "zh",
    command: "printf '%s>%s' $INPUT_LANG $OUTPUT_LANG",
    platform: "linux",
  });
  assert.equal(translated, "en>zh");
});

test("translateText rejects when the command exits non-zero", async () => {
  await assert.rejects(
    translateText({
      text: "hello",
      inputLang: "en",
      outputLang: "zh",
      command: "echo boom >&2; exit 3",
      platform: "linux",
    }),
    /boom/,
  );
});

test("translateText rejects when the command prints nothing", async () => {
  await assert.rejects(
    translateText({
      text: "hello",
      inputLang: "en",
      outputLang: "zh",
      command: "true",
      platform: "linux",
    }),
    /no output/,
  );
});

test("translateText rejects empty text", async () => {
  await assert.rejects(
    translateText({
      text: "   ",
      inputLang: "en",
      outputLang: "zh",
      command: "printf '%s' $PROMPT",
      platform: "linux",
    }),
    /non-empty/,
  );
});

test("translateText is unavailable without a command on non-macOS platforms", async () => {
  await assert.rejects(
    translateText({
      text: "hello",
      inputLang: "en",
      outputLang: "zh",
      platform: "linux",
    }),
    (error: unknown) => {
      assert.ok(error instanceof TranslationUnavailableError);
      return true;
    },
  );
});

test("macOS translation rebuilds a cached helper removed from the temp directory", async (t) => {
  let binaryExists = false;
  let compileCount = 0;
  setMacOSTranslationBackendForTests({
    binaryExists: () => binaryExists,
    compileBinary: async () => {
      compileCount += 1;
      binaryExists = true;
      return "/tmp/codex-deck-translate-test";
    },
    runProcess: async () => ({ stdout: "translated", stderr: "" }),
  });
  t.after(() => setMacOSTranslationBackendForTests(null));

  const options = {
    text: "hello",
    inputLang: "en",
    outputLang: "zh",
    platform: "darwin" as const,
  };
  assert.equal(await translateText(options), "translated");
  binaryExists = false;
  assert.equal(await translateText(options), "translated");
  assert.equal(compileCount, 2);
});

test("macOS translation retries when the helper disappears before spawn", async (t) => {
  let compileCount = 0;
  let runCount = 0;
  setMacOSTranslationBackendForTests({
    binaryExists: () => true,
    compileBinary: async () => {
      compileCount += 1;
      return "/tmp/codex-deck-translate-test";
    },
    runProcess: async () => {
      runCount += 1;
      if (runCount === 1) {
        const error = new Error("spawn helper ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return { stdout: "translated", stderr: "" };
    },
  });
  t.after(() => setMacOSTranslationBackendForTests(null));

  assert.equal(
    await translateText({
      text: "hello",
      inputLang: "en",
      outputLang: "zh",
      platform: "darwin",
    }),
    "translated",
  );
  assert.equal(compileCount, 2);
  assert.equal(runCount, 2);
});
