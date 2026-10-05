# guide.json contract

Write UTF-8 JSON. The LLM authors explanations, line ranges, and symbol mappings. The builder reads source from the snapshot, verifies it, and adds code; do not copy source into the manifest. Paths are repository-relative, lines are one-based, and ranges include both ends.

## Required structure

Copy `comparison` from `snapshot.json` exactly, including its resolved commits, fingerprint, repository identity, and exclusions. The example below is illustrative; replace its metadata and ranges with captured values.

```json
{
  "title": "Limit the returned search results",
  "language": "en",
  "overview": "Follow the request through search and response handling.",
  "comparison": {
    "kind": "worktree",
    "ref": null,
    "base": "[resolved HEAD commit hash]",
    "head": "[resolved HEAD commit hash]",
    "repositoryId": "[captured repository identity]",
    "excluded": [],
    "fingerprint": "[captured snapshot fingerprint]"
  },
  "steps": [
    {
      "id": "search-limit",
      "group": "Request",
      "title": "Return fewer results",
      "file": "src/search.ts",
      "heading": "Keep the total count while limiting the returned list",
      "why": "Previously the response included every match. It now returns only the requested number, while retaining the full count for pagination.",
      "notes": [
        {
          "title": "Trim the list",
          "start": 27,
          "end": 29,
          "text": "The limit changes the returned list, not the total count."
        }
      ],
      "check": "Does the test distinguish total matches from returned results?",
      "next": "The guide is complete."
    }
  ],
  "definitions": {
    "SearchResult": {
      "name": "SearchResult",
      "path": "src/types.ts",
      "start": 10,
      "end": 13,
      "description": "Carries the full count and the current page of results."
    }
  },
  "links": [
    {
      "path": "src/search.ts",
      "line": 28,
      "text": "SearchResult",
      "definition": "SearchResult"
    }
  ]
}
```

`kind` is `worktree`, `commit`, `branch`, or `tag`; `ref` is the original selector or null for default changes. `base` is the resolved baseline itself, not a merge base. `head` is the captured current HEAD; it does not identify uncommitted code. Both are null before the first commit. The fingerprint identifies captured before/after paths, contents, modes, and comparison metadata. The repository identity derives from the common Git directory, so linked worktrees share a repository identity while their snapshots distinguish contents.

`title`, `comparison`, and `steps` are required. `language` defaults to `en`; `ko` is also supported for controls. Explanations can use any language. `overview` and ISO `date` are optional. Preserve the original date for an existing guide unless refreshing it.

Every changed file must appear in at least one step. IDs must be unique lowercase letters/digits/hyphens, starting with a letter or digit. Step fields `group,title,file,heading,why,check,next` are required nonempty strings. There is no fixed number of groups or steps. Use the new path for a rename. Empty `notes` are valid for binary, submodule, empty-file, mode-only, and pure-rename changes.

## Notes and references

Notes require `title,start,end,text`. `side` defaults to `right` (current code), except deleted files default to `left` (baseline). Set `side: "left"` to explain removed lines in a modified file. Every line in a note must be initially visible in the diff, including visible context. A range cannot cross a hidden gap.

Step and note array order determines reading order. Mobile Code previous/next follows individual notes across steps; a step without notes remains one file-change stop.

For unchanged or hidden code, add a definition or optional step `reference`:

```json
{
  "path": "src/client.ts",
  "side": "right",
  "start": 71,
  "end": 74,
  "label": "Existing search client",
  "text": "This method sends the request to the search API."
}
```

The builder adds reference code. `left` reads baseline and requires the old path for renamed/deleted files; `right` reads captured current code. References, definitions, and transition citations can use unchanged files present in the captured trees.

## Connections

For new guides, add a `transition` to every step except the final one. Keep the reason for moving in the step's `next` text:

```json
{
  "next": "The request calls the search client; follow that method to response handling.",
  "transition": {
    "to": "response",
    "basis": "source",
    "evidence": [
      {
        "path": "src/request.ts",
        "side": "right",
        "start": 27,
        "end": 29,
        "text": "The request passes its limit to the client."
      }
    ]
  }
}
```

`to` must match the immediately following step's ID. The final step cannot have a transition. `basis` is:

- `source`: at least one citation explains a traced connection. Source citation is not proof of a call graph.
- `inferred`: a nonempty `uncertainty` states what remains unverified; evidence is optional.
- `reading`: `next` explains conceptual ordering such as implementation → tests; evidence is optional.

Each evidence item requires `path,side,start,end,text`. Binary files, directories, and submodules cannot supply text evidence. Transition/evidence objects reject unknown fields; do not supply code, rows, or URLs. `uncertainty` is permitted only with `inferred`.

Older manifests without transitions still build. Partial transitions produce warnings for missing connections; resolve them in new guides. The HTML summarizes authored connection types, not execution-path completeness.

## Definitions and symbol occurrences

`definitions` maps IDs to `path,start,end,description`, optional `name`, and optional `side` (default `right`). Use complete definitions or clearly label an excerpt. Select the symbol actually used; inspect imports, aliases, and receiver types.

`links` supplies explicit occurrences in current code for any language:

```json
[
  {
    "path": "src/search.ts",
    "line": 28,
    "text": "SearchResult",
    "definition": "SearchResult"
  },
  {
    "path": "src/search.ts",
    "line": 40,
    "text": "client.fetch",
    "column": 15,
    "definition": "SearchClient.fetch"
  }
]
```

`column` is a zero-based Unicode code-point offset. Omit it only when `text` occurs once on the line. The builder checks the text, converts offsets for browser UTF-16 indexing, and rejects overlaps and unknown definition IDs. These are authored links, not language-server resolution. Deleted code can use left-side notes/references; automatic occurrence links apply to current code.

For Python, optional `pythonSymbols` maps a path to `{localIdentifier: definitionId}`. Tokenization skips comments/strings. Use only for names with consistent resolution throughout a file. Do not duplicate occurrences already supplied by explicit links. Tokenization requires a Python version compatible with the source; use explicit links otherwise.

## Observed evidence and attribution

Optional `recap` is an array of strings describing actual validation and limits. Optional `finding` has `title,body,fix,url` and optional `label`; its URL must be HTTPS. Include only existing grounded findings, never invented test results or review publication states.

Optional top-level `attribution: {title,text,url}` embeds notices required for the toured code; `url` must be HTTPS. This is separate from the bundled renderer and dependency licenses, which are always retained.

## Capture and regeneration

`capture_diff.py` writes a compact source snapshot and its parsed `files` for authoring. Each file records `path,oldPath,status,oldMode,newMode,rows,lineCount,oldLineCount,added,removed`, plus any preview notice. Diff rows have `kind,text,old,new`; `gap` rows contain hidden unchanged `lines`. Snapshot schema version 2 stores `mode,oid` entries in `left`/`right`; `blobs` maps each Git blob object ID to one base64-encoded zlib-compressed payload. Identical contents share a payload across paths and sides. Unchanged binary or non-UTF-8 files are omitted from both sides; changed binary files, renames, and mode changes are retained. Complete text source remains frozen for unchanged definitions and references. Use `read_source.py` to decode and read numbered source.

Build with `--snapshot` for reproducible rendering. The builder recomputes diffs from frozen contents rather than trusting snapshot `files`. Without it, the builder recaptures current code (using the CLI selector or default HEAD), restores recorded exclusions, and rejects mismatched comparison metadata. New output paths are protected; use `--overwrite` for intentional updates. The final JSON reports output path, comparison, file/step/definition counts, size, unavailable previews, transitions, warnings, and source verification.

## Maintaining the skill

From the repository root, run `python3 -m unittest discover -s skills/codex-deck-diff/tests -p 'test_*.py'`. The optional browser smoke test uses an installed Node `playwright` package: `node skills/codex-deck-diff/tests/test_viewer.cjs`. Set `DIFF_TOUR_BROWSER_CHANNEL=chrome` to use an installed Chrome instead of Playwright's Chromium. It creates an isolated fixture and reports the directory containing generated HTML and desktop/mobile screenshots.

Retain the bundled renderer's MIT notice and the vendored highlight.js license; both are embedded into generated HTML.
