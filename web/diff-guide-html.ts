import {
  diffGuideTranslationRuntime,
  diffGuideTranslationStyles,
} from "./diff-guide-translation-runtime";

// A sandboxed srcdoc uses system media preferences independently of the app.
// Apply the selected theme only to stylesheet blocks, preserving source snapshots.
export function applyDiffGuideTheme(
  html: string,
  theme: "light" | "dark",
): string {
  return html.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_match, start: string, css: string, end: string) => {
      const themed = css.replace(
        /@media\s*\(prefers-color-scheme:\s*dark\)/gi,
        theme === "dark" ? "@media all" : "@media not all",
      );
      return start + themed + end;
    },
  );
}

/** Enhance only the in-app srcdoc; the saved standalone guide stays untouched. */
export function prepareDiffGuideHtml(
  html: string,
  theme: "light" | "dark",
  token: string,
): string {
  const themed = applyDiffGuideTheme(html, theme);
  const serializedToken = JSON.stringify(token)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  const enhancement = `<style id="deck-diff-translation-styles">${diffGuideTranslationStyles}</style><script id="deck-diff-translation-runtime">${diffGuideTranslationRuntime}(${serializedToken});</script>`;
  return themed.replace(
    /<\/body>(\s*<\/html>\s*)$/i,
    (_match, end: string) => enhancement + "</body>" + end,
  );
}
