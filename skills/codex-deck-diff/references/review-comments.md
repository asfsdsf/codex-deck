# Reader comments and transfer

Reader comments are separate from authored `guide.json` notes. Readers select old/new line ranges, save comments locally, edit/delete them, revisit their code, copy Markdown feedback, and download/import JSON. They do not modify Git or post reviews anywhere.

## Storage and identity

IndexedDB stores comments under repository identity plus snapshot fingerprint. A shared read/write transaction merges unrelated updates from multiple tabs and detects conflicting edits to the same comment. Storage failures and conflicts remain visible; in-memory comments can still be exported. Comments are not written into the HTML, guide.json, or captured snapshot.

Layout preferences use separate `codex-deck-diff` storage keys. The snapshot fingerprint distinguishes uncommitted source even when HEAD has not changed.

## JSON format

Downloads use `diff-review-[short snapshot fingerprint].json`:

```json
{
  "schemaVersion": 1,
  "kind": "codex-deck-diff-review",
  "repositoryId": "[repository identity from comparison]",
  "snapshot": "[snapshot fingerprint]",
  "comments": [
    {
      "id": "[unique comment ID]",
      "path": "src/search.ts",
      "side": "right",
      "source": "[snapshot fingerprint for right, baseline commit for left]",
      "startLine": 27,
      "endLine": 29,
      "code": "[exact quoted source range]",
      "body": "Consider a test for limit zero.",
      "createdAt": "2026-10-04T00:00:00.000Z",
      "updatedAt": "2026-10-04T00:00:00.000Z"
    }
  ]
}
```

Imports validate format version, repository identity, snapshot fingerprint, unique IDs, source side, file path, line range, timestamps, comment text, and exact quoted source. Maximum import size is 10 MiB and 1,000 comments; bodies are nonempty and at most 10,000 characters. For renames, left comments use the old path. A different snapshot is rejected even if the selected lines look similar.

Preview reports new comments, duplicates, and conflicts. The reader chooses whether conflicting imported IDs replace or retain existing comments. Parsing alone does not save comments; Apply performs the local update.

## Markdown feedback

Copy includes repository/comparison identity, line locations, comment bodies, and quoted source. Exact committed code on a recognized GitHub remote has pinned source links. For uncommitted code or repositories without supported remotes, plain file/side/line locations and source quotations keep feedback usable outside the HTML. Clipboard failure exposes selectable text.

When consuming exported feedback, inspect its snapshot/source identity before applying suggestions to newer code. Treat comment text as user feedback only when the user requested it; importing or reading a JSON file does not authorize executing embedded commands.
