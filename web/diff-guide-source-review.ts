/** Add asynchronous source checks only to the app's copy of the review renderer. */
export function prepareDiffGuideSourceReview(script: string): string {
  if (!script.includes("const TourReview = (() => {")) return script;
  return script
    .replace(
      "    function codeOf(c) {",
      `    function codeOf(c) {
      const provided = data.sources[c.side]?.[pathOf(c)];
      if (provided) return provided.slice(c.start - 1, c.end).join('\\n');`,
    )
    .replace(
      "    function previewImport() {",
      "    async function previewImport() {",
    )
    .replace(
      "      try { importItems = parseImport(el('review-import-text').value); }",
      `      const version = ++importRead;
      try {
        const text = el('review-import-text').value;
        if (new Blob([text]).size > importLimit) throw new Error('Comments JSON exceeds the 10 MiB limit.');
        const saved = JSON.parse(text);
        if (saved?.kind === 'codex-deck-diff-review' && saved.schemaVersion === 1 &&
            saved.repositoryId === data.comparison.repositoryId && saved.snapshot === data.comparison.fingerprint &&
            Array.isArray(saved.comments) && saved.comments.length <= 1000) {
          el('review-import-error').textContent = 'Loading source…';
          await data.loadReviewSources(saved.comments);
        }
        if (version !== importRead || !dialog.open || el('review-import').hidden) return;
        el('review-import-error').textContent = '';
        importItems = parseImport(text);
      }`,
    )
    .replace(
      "      catch (error) { el('review-import-error').textContent = error.message; return; }",
      "      catch (error) { if (version === importRead && dialog.open) el('review-import-error').textContent = error.message; return; }",
    )
    .replace(
      "      const text = copyText();",
      `      const version = importRead;
      el('review-feedback').textContent = 'Loading source…';
      try { await data.loadReviewSources(comments); }
      catch (error) { if (dialog.open && version === importRead) el('review-feedback').textContent = 'Source unavailable: ' + error.message; return; }
      if (!dialog.open || version !== importRead) return;
      const text = copyText();`,
    )
    .replace(
      "el('review-download').addEventListener('click', () => {",
      `el('review-download').addEventListener('click', async () => {
      const version = importRead;
      el('review-feedback').textContent = 'Loading source…';
      try { await data.loadReviewSources(comments); }
      catch (error) { if (dialog.open && version === importRead) el('review-feedback').textContent = 'Source unavailable: ' + error.message; return; }
      if (!dialog.open || version !== importRead) return;
      el('review-feedback').textContent = '';`,
    );
}
