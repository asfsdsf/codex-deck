# Codex Deck plugins

Open **Plugins** from the sidebar or enter `/plugins`. Codex plugins continue to use the Codex marketplace. Codex Deck plugins are folders of reviewed local files. The plugin API evolves directly during development; manifests do not declare an API version.

## Package and permissions

```json
{
  "schemaVersion": 1,
  "id": "example.assistant",
  "name": "Assistant",
  "version": "1.0.0",
  "description": "An optional background assistant.",
  "capabilities": [
    "backend.execute",
    "worker.request",
    "sessions.events",
    "sessions.read",
    "sessions.submit",
    "data.read",
    "data.write",
    "secrets.read",
    "secrets.write",
    "status.write",
    "http.request"
  ],
  "entrypoints": { "settings": "settings.html", "backend": "worker.mjs" },
  "contributions": {
    "settings": { "title": "Assistant" },
    "sessionToggle": { "label": "Assistant" },
    "sessionTip": true
  }
}
```

Declare at least one entrypoint: `panel` and `settings` refer to HTML files, and `backend` refers to a `.js`, `.mjs`, or `.cjs` Node.js entrypoint. Every declared entrypoint must exist. `backend` requires `backend.execute`. `settings` contributions require a settings entrypoint. The [Release Notes example](../examples/deck-plugins/release-notes/) demonstrates a panel without a worker.

Capabilities are checked at each host operation:

| Capability                      | Access                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `context.read`                  | Panel's selected thread and project path                                             |
| `state.read`, `state.write`     | Browser-visible JSON state, at most 64 KiB                                           |
| `backend.execute`               | Execute trusted local code in a separate Node.js process                             |
| `worker.request`                | Send UI requests to this plugin's worker                                             |
| `sessions.events`               | Receive thread lifecycle, interaction and manual-action events                       |
| `sessions.read`                 | Read current thread history/state, enabled sessions and submission reconciliation    |
| `sessions.submit`               | Submit a guarded `continue` to an enabled, failed session                            |
| `codex.homes.read`              | List configured Codex homes, including paths and availability                        |
| `codex.sessions.manage`         | Create and manage persistent plugin-owned, read-only Codex sessions in a chosen home |
| `data.read`, `data.write`       | Private persistent worker data, at most 4 MiB                                        |
| `secrets.read`, `secrets.write` | Worker reads and writes secret values; browser reads presence only                   |
| `status.write`                  | Publish per-session phase, reason, deadline, next-check timestamp and tip actions    |
| `http.request`                  | Non-streaming HTTP POST through the daemon's configured proxy                        |

A backend worker is **trusted local code**, with the daemon user's filesystem and network permissions. Host RPC capability checks constrain host operations; they do not sandbox Node.js itself. Package review explicitly shows the executable backend permission and source, including worker modules. Review the entire package before installing or updating.

Choose **Import plugin folder**, review the source, confirm trust, and install. Updates keep the same ID and require a different package version and renewed source review. Enable, disable, uninstall, source inspection and panel opening are available in plugin details. Settings contributions appear as individual panes in **Settings**. Session-row toggles default to off and persist on the daemon, shared by all browsers. Tips show status for the selected session; countdowns use server timestamps to account for browser clock skew.

Packages are limited to 8 MiB and 256 files; manifests to 128 KiB; a Codex home to 64 installed plugins. Paths cannot escape the package, use reserved directories, or contain symbolic links. Installed worker trees are checked before execution. Bundle dependencies into the package or use relative imports; `node_modules` is not an installable package directory. The `codex-deck.` ID prefix is reserved.

## Browser bridge

Panels and settings run in sandboxed iframes with an opaque origin and restrictive CSP. Relative scripts, CSS, images and other package assets can load; arbitrary browser networking, parent DOM access and browser storage are unavailable. The bridge checks iframe source, capabilities, message size (64 KiB), and request rate (60 per minute).

Requests use `parent.postMessage({ channel: "codex-deck-plugin", type: "request", requestId, method, params }, "*")`. Responses have the same channel and request ID, and either `result` or `error`. The host sends `initialize` with plugin identity, capabilities, permitted context/state, and `theme` (`light` or `dark`). Subsequent theme changes send `{ type: "theme", theme }`.

| Method          | Params                                            | Result                                        |
| --------------- | ------------------------------------------------- | --------------------------------------------- |
| `getContext`    | none                                              | `{ threadId, cwd }`                           |
| `getState`      | none                                              | Browser-visible saved state                   |
| `setState`      | `{ state }`                                       | Saved state                                   |
| `workerRequest` | `{ method, params }`                              | Worker-defined result                         |
| `getSecrets`    | none                                              | Secret names mapped to booleans, never values |
| `setSecrets`    | `{ apiKey: "replacement" }` or `{ apiKey: null }` | Updated presence map                          |

Secret inputs should use password fields. Leave an input blank to retain the configured value; explicitly send `null` to clear it. Never save credentials in browser-visible state or return them from a worker-defined UI operation.

## Worker protocol

The daemon starts enabled workers on initialization, including additional Codex-home runtimes, and reconciles installs, enablement, updates, uninstall and unexpected exits. Browser connections do not own workers. Workers use Node's IPC channel (`process.on("message")`, `process.send`) and receive:

- `{ type: "initialize", plugin: { id, version } }`; reply `{ type: "ready" }` after initialization.
- `{ type: "event", event }` for lifecycle and settings events.
- `{ type: "request", requestId, method, params }` for UI operations. Reply `{ type: "response", requestId, result }` or `{ type: "response", requestId, error }`.
- A `host.shutdown` request before stopping a ready worker. Its `params.cancel` is true for disable, update or uninstall, and false for daemon shutdown (preserve episodes for restart). Persist cancellation and reply promptly. Submission permission is revoked immediately; private data/status writes remain available during the short shutdown grace period. SIGTERM/SIGKILL follow if needed. Exit on IPC disconnect to avoid orphaned workers.

Workers call host RPC using `{ type: "request", requestId, method, params }`; responses use the same response envelope. Host methods:

| Method                     | Params / result                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data.get`                 | Read this plugin's private JSON object                                                                                                                                                                                    |
| `data.set`                 | `{ data }`; atomically replace private data                                                                                                                                                                               |
| `secrets.get`              | Read this worker's secret object                                                                                                                                                                                          |
| `secrets.set`              | `{ secrets: { name: valueOrNull } }`; replace/clear selected keys                                                                                                                                                         |
| `sessions.list`            | Map of thread IDs to this plugin's persisted toggle values                                                                                                                                                                |
| `sessions.get`             | `{ threadId }`; fresh turns (including final `assistantText`), terminal errors/timestamps, `cwd`, session file `path`, `codexHome`, active turn, pending interactions, queue state, manual-action timestamp, and revision |
| `sessions.submit`          | `{ threadId, text: "continue", expectedTurnId, revision, expiresAt, requestId }`; durable submission intent/result                                                                                                        |
| `sessions.submission`      | `{ requestId }`; reconcile an existing intent against actual history                                                                                                                                                      |
| `status.set`               | `{ threadId, status: { phase, reason, nextAt?, deadline?, actions? } }`; `null` clears status                                                                                                                             |
| `http.request`             | `{ url, headers, body }`; returns `{ status, body }`                                                                                                                                                                      |
| `codex.homes.list`         | Configured homes as `{ id, label, path, available, unavailableReason }[]`                                                                                                                                                 |
| `codex.sessions.ensure`    | `{ key, homeId, cwd }`; idempotently create/reuse a plugin-owned thread, returning `{ sessionId, threadId, homeId, homePath }`                                                                                            |
| `codex.sessions.submit`    | `{ sessionId, requestId, text, outputSchema? }`; persist submission intent and return `{ phase, turnId, ... }`                                                                                                            |
| `codex.sessions.get`       | `{ sessionId, requestId? }`; return the reference, fresh `session` state and reconciled `submission` (or null)                                                                                                            |
| `codex.sessions.interrupt` | `{ sessionId, requestId }`; interrupt only the active turn matching that plugin's submission                                                                                                                              |

HTTP requests use `curl`, available on the supported daemon platforms, with inherited/configured HTTP(S)/NO_PROXY environment, a 120-second timeout and 4 MiB response limit. They do not follow redirects or expose provider stderr in errors. Worker shutdown aborts requests. API keys remain in separate server files with mode `0600`, under directories created with mode `0700`.

Status `actions` can contain up to four `{ id, label }` buttons and require `worker.request`. IDs must be unique nonempty strings of at most 512 characters; labels are at most 80 characters. Clicking a button calls that plugin's worker with `status.action` and `{ threadId, actionId }`, scoped to the original Codex home. Bind action IDs to their recovery episode or equivalent context, and reject stale actions. Workers own cancellation/dismissal and publish the resulting status, so all browsers receive the change. Tip backgrounds use the same 72% opacity as the Working indicator.

Lifecycle `thread_status` events preserve `terminalStatus` (`completed`, `failed`, `interrupted`), `error`, `turnId`, and the server timestamp on completion. Error events independently preserve `willRetry`; an error notification alone never establishes a terminal failed turn. The host additionally publishes `manual_action` and `session_toggle` events. Durable manual-action timestamps let workers detect actions missed during a restart.

Before guarded submission, the host serializes by session and rechecks plugin and session enablement, interactive status, the expected latest failed turn, revision, active turns, input/approval/elicitation waits, and queued messages. Unknown queue support blocks automatic submissions. The host persists intent before calling Codex and checks the revision and submission deadline again immediately before turn submission. Duplicate requests for the same failed turn share the recorded intent, including different request IDs. An ambiguous result stays ambiguous until actual history proves acceptance; it is never blindly resent. Workers must also persist their own episode/intents before calling the host and reconcile on restart. These facilities do not edit rollout logs or invoke Fix dangling.

Plugin-owned Codex sessions use the chosen home's authentication, provider, default model, reasoning effort and proxy. They run with read-only filesystem permissions, no approval prompts, and no MCP or Deck dynamic tools. The host retains a separate connection per selected home and closes those connections on daemon shutdown. Creation is serialized and keyed by plugin ID, canonical home path and the plugin's `key`; the mapping survives restarts and plugin updates. A changed home path cannot silently redirect an existing reference. Cross-home operations work from additional-home plugin runtimes as well as the main runtime.

The plugin-owned session API accepts arbitrary diagnostic text only for threads it created; it cannot submit that text to existing user threads. It checks active turns, interaction waits, queue state and worker enablement before sending. Persist the request ID and original text before invoking submit. Reusing a request ID reconciles its intent against history instead of resending; an ambiguous intent also blocks new request IDs. Read `submission.turnId` and wait for that exact turn to complete before interpreting its `assistantText`. Incomplete, failed or interrupted turns must not authorize actions. On plugin disable/update/uninstall, the host attempts to interrupt its latest owned turns. Reuse an appropriate key (for example a target thread ID) to retain diagnostic context across multiple judgments.

## Storage and synchronization

Everything is scoped to the selected Codex home:

```text
<home>/codex-deck/plugins/<id>/                 reviewed package files
<home>/codex-deck/plugins.json                 installation and enablement registry
<home>/codex-deck/plugin-data/<id>.json         browser-visible state
<home>/codex-deck/plugin-backend/<id>/data.json private worker state
<home>/codex-deck/plugin-backend/<id>/ui.json   session toggles and public status
<home>/codex-deck/plugin-backend/<id>/secrets.json
<home>/codex-deck/plugin-backend/<id>/submissions.json
<home>/codex-deck/plugin-backend/<id>/codexsessions.json
```

Internal session lifecycle checkpoints use the reserved `codex-deck.lifecycle` private namespace. Updates preserve plugin state and secrets; uninstall removes the plugin's private data as well as package and browser state.

`GET /api/deck/plugins/contributions` returns the full contribution snapshot and `serverTime`. Registry, toggle and worker status changes broadcast `native_state_changed` with scope `deck-plugins` through existing local SSE and encrypted remote session deltas. Browsers fetch fresh snapshots on notifications and every reconnect, including returning from a hidden tab. Worker UI calls start with `POST /api/deck/plugins/:id/worker` returning a `requestId`, then poll `GET /api/deck/plugins/:id/worker/:requestId` for `{ done, result?, error? }`. Jobs expire after five minutes; short polling keeps long connection tests within existing remote relay timeouts. Browser bridge requests pin their original Codex home even if the user switches homes while a call is pending. Local and remote modes use the same plugin endpoints; no new unencrypted remote payload or direct browser-to-cli connection is introduced.

## Auto recovery local plugin

The Auto recovery implementation is deliberately outside this repository at `~/.codex/codex-deck/plugins/auto-recovery/`. Its package contains settings, a backend worker, separate API and Codex diagnostic default prompts, a deterministic recovery engine and mocked tests. Import that folder into each Codex home where it is needed. In Settings → Auto recovery, **Judge with** selects **Direct LLM API** or a configured Codex home. Direct API mode starts with URL and key unset and model `gpt-6-luna`. Credentials are not imported from any other tool. Add homes through Codex Deck's Codex homes settings before selecting one here.

Enable a session's **Auto recovery** switch to opt in. Confirmed failed turns start one persistent episode, first judged after 30 seconds. Further judgments follow 1 minute, 5 minutes, 10 minutes, then 30 minutes repeatedly, including judge outages, wait decisions and unsuccessful continuations. A single deadline expires 24 hours after the original failure. Successful completion, deliberate interruption, manual submission/stop, archive/delete or disablement cancels pending work. Provider configuration/authentication failures block until corrected settings are saved, subject to the original deadline.

The recovery tip offers **Cancel retry** to stop the current episode without disabling future recovery for the session. Success and cancellation clear the tip automatically. Expired episodes and judge stop decisions stay visible with a **Close** action; dismissal persists across browsers and daemon restarts. Canceling while an automatic continuation is running also suppresses retries if that continuation fails.

Direct API judgment uses non-streaming Responses requests at `<base URL>/responses`, bearer auth and optional reasoning effort. Choosing a Codex home creates one diagnostic session per target in that home and reuses it across retries, subsequent recovery episodes and restarts. Codex mode uses the home's model and credentials instead of the direct API fields. Diagnosis starts in the selected home directory to avoid inheriting the failed workspace's project configuration. Its different default prompt asks the diagnostic session to inspect the target's transcript and relevant local files read-only. A slow or uncertain judgment retains its request ID and is checked again on the next retry; stale results from a different failed turn or edited prompt are discarded. Changing the selected home creates a separate mapping; returning to a previous home reuses its session.

Both modes supply a separate strict response contract for `continue`, `wait`, or `stop`, each with a reason. Invalid/incomplete responses cannot authorize continuation. Separate editable prompts and reset defaults are retained per mode. Both prompts support `$SESSION_ID`, `$SESSION_PATH` (session file), `$SESSION_CWD` (working directory), `$SESSION_CODEX_HOME` (the target's home), `$ERROR_MSG`, `$ERROR_DETAILS`, `$RECOVERY_HISTORY`, `$ATTEMPT_COUNT`, `$CONTINUE_COUNT`, `$ELAPSED_TIME`, `$TIME_REMAINING`, and `$LAST_JUDGE_ERROR`. Test connection performs an API call or uses a separate diagnostic test session in the chosen home, without continuing a target session.

Run the plugin's tests with `node --test ~/.codex/codex-deck/plugins/auto-recovery/*.test.mjs`. They mock both judge and session host, so tests cannot make paid model calls or resume real sessions.
