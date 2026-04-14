import { useSyncExternalStore } from "react";
import { THEME_ATTRIBUTE, type ResolvedTheme } from "../theme";

function readResolvedTheme(): ResolvedTheme {
  if (typeof document === "undefined") {
    return "dark";
  }

  return document.documentElement.getAttribute(THEME_ATTRIBUTE) === "light"
    ? "light"
    : "dark";
}

function subscribe(onStoreChange: () => void): () => void {
  if (
    typeof document === "undefined" ||
    typeof MutationObserver === "undefined"
  ) {
    return () => {};
  }

  const root = document.documentElement;
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (
        mutation.type === "attributes" &&
        mutation.attributeName === THEME_ATTRIBUTE
      ) {
        onStoreChange();
        return;
      }
    }
  });

  observer.observe(root, {
    attributes: true,
    attributeFilter: [THEME_ATTRIBUTE],
  });

  return () => {
    observer.disconnect();
  };
}

export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, readResolvedTheme, () => "dark");
}
