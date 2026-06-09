import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_TITLE_MODE_STORAGE_KEY,
  buildBrowserTitle,
  normalizeBrowserTitleMode,
  persistBrowserTitleMode,
  readBrowserTitleMode,
} from "../../web/browser-title";

test("normalizeBrowserTitleMode accepts known modes", () => {
  assert.equal(normalizeBrowserTitleMode("app"), "app");
  assert.equal(normalizeBrowserTitleMode("session"), "session");
  assert.equal(normalizeBrowserTitleMode("project"), "project");
  assert.equal(normalizeBrowserTitleMode("unknown"), "app");
  assert.equal(normalizeBrowserTitleMode(null), "app");
});

test("read and persist browser title mode use stable storage key", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };

  assert.equal(readBrowserTitleMode(storage), "app");
  persistBrowserTitleMode(storage, "session");
  assert.equal(store.get(BROWSER_TITLE_MODE_STORAGE_KEY), "session");
  assert.equal(readBrowserTitleMode(storage), "session");
});

test("buildBrowserTitle formats selected mode with fallbacks", () => {
  assert.equal(buildBrowserTitle({ mode: "app" }), "Codex Deck");
  assert.equal(
    buildBrowserTitle({
      mode: "session",
      sessionDisplay: "Fix tests",
      projectPath: "/repo/app",
    }),
    "Fix tests - Codex Deck",
  );
  assert.equal(
    buildBrowserTitle({
      mode: "session",
      projectPath: "/repo/app",
    }),
    "app - Codex Deck",
  );
  assert.equal(
    buildBrowserTitle({
      mode: "project",
      projectPath: "/repo/app/",
    }),
    "app - Codex Deck",
  );
});
