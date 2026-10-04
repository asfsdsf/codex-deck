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
