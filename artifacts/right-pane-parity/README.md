# Right pane comparison

The implementation remains in `codex-deck-right-pane`, branch `feat/right-pane-deepseek-design`.

Open [the side-by-side gallery](index.html) to compare Start, Files, Markdown preview, Git, and Tasks in light and dark themes. Each capture uses a 1440 × 900 viewport and a 648px right pane.

The reference is the running DeepSeek Harness at port 3080, including the installed `dsh-better-sidebar` plugin. The reference Start capture hides unrelated entries to match the requested Files/Git/Tasks scope. Files and Markdown use the same read-only workspace fixture in both browsers; this does not modify the reference workspace. Git uses each app's own selected workspace, so file names, branches, and history differ. The reference's floating `watch.open` debug badge is not part of Codex Deck.

Shared header and file-toolbar control geometry (position and size, largest difference among matching controls):

| Theme | Surface | Largest difference | Codex page errors |
| --- | --- | --- | --- |
| light | start | 0.00px | 0 |
| light | files | 0.00px | 0 |
| light | preview | 0.00px | 0 |
| light | git | 0.00px | 0 |
| light | tasks | 0.00px | 0 |
| dark | start | 0.00px | 0 |
| dark | files | 0.00px | 0 |
| dark | preview | 0.00px | 0 |
| dark | git | 0.00px | 0 |
| dark | tasks | 0.00px | 0 |

The gallery includes the measured control data in `metrics.json`. These measurements check control boxes; they are not a claim that every dynamic state or every rendered pixel is identical.

## Verification

- `pnpm test`: 1,100 unit tests pass.
- `pnpm build` and `pnpm typecheck:web` pass.
- `PLAYWRIGHT_CHANNEL=chrome pnpm exec playwright test tests/integration/right-pane.spec.ts --reporter=line`: five browser tests cover light/dark Markdown, local navigation, multiple file tabs, split panes, explicit Save, conflicting edits, two-browser refresh, narrow layouts, and file uploads.
- Twenty comparison captures (five surfaces × two themes × two apps), with no Codex page errors.

## Repeat the comparison

```sh
node scripts/compare-right-pane.mjs \
  --reference http://127.0.0.1:3080/ \
  --deck http://127.0.0.1:12002/ \
  --auth "[path to local Playwright storage state]" \
  --workspace "[path to the reference workspace]"
```

Static file-type artwork is adapted from `third_party/deepseek-harness`; sidebar glyphs are from the installed Harness/plugin UI. Both MIT notices are retained under `web/components/deepseek/`.
