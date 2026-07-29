import assert from "node:assert/strict";
import test from "node:test";
import {
  expandTranslationCommand,
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

test("translateText preserves spaces, quotes, and newlines in the prompt", async () => {
  const text = "it's a \"test\"\nwith a second line  and  spaces";
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
