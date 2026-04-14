import assert from "node:assert/strict";
import test from "node:test";
import {
  applyResolvedTheme,
  getNextThemePreference,
  persistThemePreference,
  readStoredThemePreference,
  resolveThemePreference,
  THEME_ATTRIBUTE,
  THEME_STORAGE_KEY,
} from "../../web/theme";

test("readStoredThemePreference falls back to system for missing or invalid values", () => {
  assert.equal(readStoredThemePreference(null), "system");
  assert.equal(
    readStoredThemePreference({
      getItem() {
        return "sepia";
      },
    }),
    "system",
  );
  assert.equal(
    readStoredThemePreference({
      getItem() {
        return "light";
      },
    }),
    "light",
  );
});

test("resolveThemePreference respects explicit themes and system fallback", () => {
  assert.equal(resolveThemePreference("system", true), "dark");
  assert.equal(resolveThemePreference("system", false), "light");
  assert.equal(resolveThemePreference("dark", false), "dark");
  assert.equal(resolveThemePreference("light", true), "light");
});

test("getNextThemePreference toggles against the resolved theme", () => {
  assert.equal(getNextThemePreference("dark", false), "light");
  assert.equal(getNextThemePreference("light", true), "dark");
  assert.equal(getNextThemePreference("system", true), "light");
  assert.equal(getNextThemePreference("system", false), "dark");
});

test("persistThemePreference stores explicit themes and clears system preference", () => {
  const calls: Array<[action: string, key: string, value?: string]> = [];
  const storage = {
    setItem(key: string, value: string) {
      calls.push(["set", key, value]);
    },
    removeItem(key: string) {
      calls.push(["remove", key]);
    },
  };

  persistThemePreference(storage, "dark");
  persistThemePreference(storage, "system");

  assert.deepEqual(calls, [
    ["set", THEME_STORAGE_KEY, "dark"],
    ["remove", THEME_STORAGE_KEY],
  ]);
});

test("applyResolvedTheme updates the document root attributes", () => {
  const attributes = new Map<string, string>();
  const toggles: Array<[className: string, force: boolean]> = [];
  const root = {
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    style: { colorScheme: "" },
    classList: {
      toggle(className: string, force: boolean) {
        toggles.push([className, force]);
      },
    },
  } as unknown as HTMLElement;

  applyResolvedTheme("light", root);

  assert.equal(attributes.get(THEME_ATTRIBUTE), "light");
  assert.equal(root.style.colorScheme, "light");
  assert.deepEqual(toggles, [["dark", false]]);
});
