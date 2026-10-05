import {
  diffGuideTranslationRuntime,
  diffGuideTranslationStyles,
} from "./diff-guide-translation-runtime";
import {
  diffGuideSourceRuntime,
  diffGuideSourceStyles,
} from "./diff-guide-source-runtime";
import { prepareDiffGuideSourceReview } from "./diff-guide-source-review";

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
  let themed = applyDiffGuideTheme(html, theme);
  const serializedToken = JSON.stringify(token)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  // Install wrappers before renderer callbacks are registered. Only the in-memory
  // script block is adapted; source text and the saved standalone HTML stay intact.
  const marker = "  let paneSizing = null;";
  themed = themed.replace(
    /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (match, start: string, script: string, end: string) => {
      if (/\btype\s*=\s*(["'])application\/json\1/i.test(start)) return match;
      if (script.includes("const TourReview = (() => {"))
        return start + prepareDiffGuideSourceReview(script) + end;
      if (
        !script.includes(
          "const data = JSON.parse(document.getElementById('guide-data').textContent);",
        ) ||
        !script.includes(marker)
      )
        return match;
      const adapter = `\n  const deckSource = ${diffGuideSourceRuntime}(${serializedToken}, data, {
    getFile: () => activeFile, getStep: () => current,
    original: {toggleContext, expandGap, openSource, renderDefinition, renderStep, revealComment},
    highlight: file => { TourSyntax.file(file, hljs); review?.invalidateSources(); },
    clearDefinition: name => highlightedDefinitions.delete(name)
  });
  ({toggleContext, expandGap, openSource, renderDefinition, renderStep, sourceUrl, revealComment} = deckSource);\n`;
      return start + script.replace(marker, marker + adapter) + end;
    },
  );
  const enhancement = `<style id="deck-diff-translation-styles">${diffGuideTranslationStyles}${diffGuideSourceStyles}</style><script id="deck-diff-translation-runtime">${diffGuideTranslationRuntime}(${serializedToken});</script>`;
  return themed.replace(
    /<\/body>(\s*<\/html>\s*)$/i,
    (_match, end: string) => enhancement + "</body>" + end,
  );
}
