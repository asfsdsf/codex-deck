# Codex Deck plugins

Open **Plugins** from the sidebar or enter `/plugins`. Codex plugins continue to use the Codex marketplace. Codex Deck plugins are folders of reviewed local files. The plugin API evolves directly during development; manifests do not declare an API version.

Deck also ships built-in plugins, marked **Built-in** in this list. Diagnostics,
Daybreak selection, experimental settings, transcript export, conversation
recaps, usage, translation and memory insights are optional. Disable them per
Codex home to remove their views, commands, routes and services. The plugin
manager is required and cannot be disabled. Built-ins cannot be uninstalled;
they update with Deck. Their code lives in `builtin-plugins/`, with shared
metadata in `catalog.ts` and separate server/browser composition modules.

The [composition design](PLUGIN_ARCHITECTURE.md) describes ownership and
lifecycle. New installed plugins can provide services, consume existing
services, add commands and contribute views without editing the application.

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
    "http.request"
  ],
  "entrypoints": { "settings": "settings.html", "backend": "worker.mjs" },
  "contributions": { "settings": { "title": "Assistant" } }
}
```

Declare at least one entrypoint or contributed view: `panel` and `settings` refer to HTML files, and `backend` refers to a `.js`, `.mjs`, or `.cjs` Node.js entrypoint. Every declared entrypoint must exist. `backend` requires `backend.execute`. `settings` contributions require a settings entrypoint. The [Release Notes example](../examples/deck-plugins/release-notes/) demonstrates a panel without a worker.

Capabilities are checked at each host operation:

| Capability                      | Access                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `context.read`                  | Panel's selected thread and project path                                             |
| `state.read`, `state.write`     | Browser-visible JSON state, at most 64 KiB                                           |
| `backend.execute`               | Execute trusted local code in a separate Node.js process                             |
| `worker.request`                | Send UI requests to this plugin's worker                                             |
| `sessions.events`               | Receive thread lifecycle, interaction and manual-action events                       |
| `sessions.read`                 | Read current thread history and live state                                           |
| `sessions.transform`            | Transform the first user message of a new session before it is sent to Codex         |
| `codex.homes.read`              | List configured Codex homes, including paths and availability                        |
| `codex.sessions.manage`         | Create and manage persistent plugin-owned, read-only Codex sessions in a chosen home |
| `data.read`, `data.write`       | Private persistent worker data, at most 4 MiB                                        |
| `secrets.read`, `secrets.write` | Worker reads and writes secret values; browser reads presence only                   |
| `status.write`                  | Publish per-session status and optional actions                                      |
| `http.request`                  | Non-streaming HTTP POST through the daemon's configured proxy                        |
| `services.call`                 | Invoke explicitly declared shared services from a worker or browser view             |
| `services.provide`              | Provide JSON RPC services in this plugin's namespace from its worker                 |

A backend worker is **trusted local code**, with the daemon user's filesystem and network permissions. Host RPC capability checks constrain host operations; they do not sandbox Node.js itself. Package review explicitly shows the executable backend permission and source, including worker modules. Review the entire package before installing or updating.

Choose **Import plugin folder**, review the source, confirm trust, and install. Updates keep the same ID and require a different package version and renewed source review. Enable, disable, uninstall, source inspection and panel opening are available in plugin details. Settings contributions appear as individual panes in **Settings**. Session-row toggles persist per Codex home and are shared by connected browsers.

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
| `callService`   | `{ service, method, params }`                     | Service-defined JSON result                   |

Secret inputs should use password fields. Leave an input blank to retain the configured value; explicitly send `null` to clear it. Never save credentials in browser-visible state or return them from a worker-defined UI operation.

## Worker protocol

The daemon starts enabled workers on initialization, including additional Codex-home runtimes, and reconciles installs, enablement, updates, uninstall and unexpected exits. Browser connections do not own workers. Workers use Node's IPC channel (`process.on("message")`, `process.send`) and receive:

- `{ type: "initialize", plugin: { id, version } }`; reply `{ type: "ready" }` after initialization.
- `{ type: "event", event }` for lifecycle and settings events.
- `{ type: "request", requestId, method, params }` for UI operations. Reply `{ type: "response", requestId, result }` or `{ type: "response", requestId, error }`.
- A `host.shutdown` request before stopping a ready worker. Its `params.cancel` is true for disable, update or uninstall, and false for daemon shutdown (preserve pending work for restart). Persist cancellation and reply promptly. Submission permission is revoked immediately; private data/status writes remain available during the short shutdown grace period. SIGTERM/SIGKILL follow if needed. Exit on IPC disconnect to avoid orphaned workers.

Workers call host RPC using `{ type: "request", requestId, method, params }`; responses use the same response envelope. Host methods:

| Method                     | Params / result                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data.get`                 | Read this plugin's private JSON object                                                                                                                      |
| `data.set`                 | `{ data }`; atomically replace private data                                                                                                                 |
| `secrets.get`              | Read this worker's secret object                                                                                                                            |
| `secrets.set`              | `{ secrets: { name: valueOrNull } }`; replace/clear selected keys                                                                                           |
| `sessions.list`            | Map of thread IDs to this plugin's persisted toggle values                                                                                                  |
| `sessions.get`             | `{ threadId }`; fresh turns, `cwd`, session file `path`, `codexHome`, active turn, pending interactions, queue state, manual-action timestamp, and revision |
| `status.set`               | `{ threadId, status }`; `null` clears status                                                                                                                |
| `http.request`             | `{ url, headers, body }`; returns `{ status, body }`                                                                                                        |
| `codex.homes.list`         | Configured homes as `{ id, label, path, available, unavailableReason }[]`                                                                                   |
| `codex.sessions.ensure`    | `{ key, homeId, cwd }`; idempotently create/reuse a plugin-owned thread, returning `{ sessionId, threadId, homeId, homePath }`                              |
| `codex.sessions.submit`    | `{ sessionId, requestId, text, outputSchema? }`; persist submission intent and return `{ phase, turnId, ... }`                                              |
| `codex.sessions.get`       | `{ sessionId, requestId? }`; return the reference, fresh `session` state and reconciled `submission` (or null)                                              |
| `codex.sessions.interrupt` | `{ sessionId, requestId }`; interrupt only the active turn matching that plugin's submission                                                                |

HTTP requests use `curl`, available on the supported daemon platforms, with inherited/configured HTTP(S)/NO_PROXY environment, a 120-second timeout and 4 MiB response limit. They do not follow redirects or expose provider stderr in errors. Worker shutdown aborts requests. API keys remain in separate server files with mode `0600`, under directories created with mode `0700`.

Published status belongs to the contributing plugin and is scoped to its Codex home. Optional actions require `worker.request`; bind action IDs to their operation context and reject stale actions.

Lifecycle events preserve `terminalStatus`, error details, `turnId`, and server timestamps. The host also publishes `manual_action` and `session_toggle` events, and stores manual-action timestamps so workers can detect actions missed during a restart.

The host validates session operations against current state and scopes them to their owning Codex home.

Plugin-owned Codex sessions use the chosen home's authentication, provider, default model, reasoning effort and proxy. They run with read-only filesystem permissions, no approval prompts, and no MCP or Deck dynamic tools. The host retains a separate connection per selected home and closes those connections on daemon shutdown. Creation is serialized and keyed by plugin ID, canonical home path and the plugin's `key`; the mapping survives restarts and plugin updates. A changed home path cannot silently redirect an existing reference. Cross-home operations work from additional-home plugin runtimes as well as the main runtime.

Call `codex.sessions.ensure` before submitting to a saved session reference. A new Codex thread has empty history until its first message and may disappear if the app-server exits before then. `ensure` recreates a missing unused thread under the same `sessionId` and returns its refreshed `threadId`. Once any submission intent is recorded, the host preserves the original thread for reconciliation and never replaces it automatically.

The plugin-owned session API can submit messages only to threads created by that plugin. Reuse a request ID to reconcile its intent against history rather than resending an ambiguous request, and wait for the matching turn before interpreting its output. On plugin disable, update or uninstall, the host attempts to interrupt its active owned turn.

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

### First-message transform hooks

Backend plugins with `sessions.transform` can declare `contributions.beforeFirstMessage`:

```json
{
  "contributions": {
    "beforeFirstMessage": {
      "method": "session.beforeFirstMessage",
      "waitingLabel": "Selecting and injecting relevant prompts…",
      "order": 10
    }
  }
}
```

When a user sends the first message of a new Codex session, the browser starts `POST /api/deck/plugins/hooks/before-first-message` and polls `GET /api/deck/plugins/hooks/before-first-message/:jobId` (with `POST .../cancel` to skip or cancel). Enabled hook plugins run sequentially by `order`, then `id`. Each worker receives `{ hookJobId, threadId, cwd, text, originalText, model, effort, mode, imageCount, audioCount }` and returns `{ text, changed?, skipped?, summary?, appliedItems? }`. While running, the worker may publish progress via `status.set` and listen for `{ type: "hook_canceled", hookJobId, threadId }` events to abort in-flight work.

## Services, commands and slots

A service is a plugin-owned JSON RPC endpoint. Declare provided and consumed
names, and optionally the services required for activation:

```json
{
  "services": {
    "provides": ["example.assistant.analysis"],
    "uses": ["codex-deck.diagnostics"]
  },
  "requires": ["codex-deck.diagnostics"],
  "contributions": {
    "views": [
      {
        "id": "analysis",
        "title": "Analysis",
        "slot": "dialog",
        "entrypoint": "analysis.html"
      }
    ],
    "commands": [
      {
        "id": "analyze",
        "title": "Analyze",
        "description": "Analyze this conversation",
        "requiresSession": true,
        "action": { "view": "analysis" }
      }
    ]
  }
}
```

Service providers require a backend plus `services.provide`. Names must equal
or begin with the provider's complete plugin ID followed by a dot. Consumers
require `services.call` and list each name in `services.uses`. `requires` must
be a subset of that list. Missing dependencies suspend workers and hide their
commands/views; restoring a provider restarts consumers. Calls are cancelled
when the provider or caller unloads, and have a 120-second limit. A service
cannot silently resolve to a provider in another home.

Workers call `services.list` to discover available declared providers and
`services.call` with `{ service, method, params }`. A ready provider receives
`service.call` requests with `{ service, method, params, caller }`, where `caller`
is the host-assigned plugin ID. Use the SDK to avoid writing the IPC protocol.

The host provides `codex-deck.chat-providers` in each home. Declare it in
`services.uses` to list saved providers with method `list`. Method `complete`
accepts `{ providerId, instructions, prompt, schema }` and makes a one-shot
Chat Completions request using the selected provider's model, reasoning
effort and credentials from the main home. Completed replies return
`{ status, content }`. HTTP failures return only the status. The host
rejects incomplete or refused replies and keeps API keys out of worker IPC.

Built-in route services use the plugin ID as their service name, such as
`codex-deck.diagnostics`, `codex-deck.recap`, `codex-deck.usage`,
`codex-deck.daybreak`, `codex-deck.experimental`, `codex-deck.translation` and
`codex-deck.memory`. Call method `request` with
`{ path: "/api/codex/warnings", method: "GET" }` (optional JSON `body` for
mutations); the result is `{ status, body }`. Each service exposes only its
plugin's own routes. URLs cannot change the Codex home. Existing route input
validation and native event broadcasts also apply to service calls.

Views use `dialog`, `settings`, `app.sidebar`, `session.toolbar`,
`session.footer`, or `memory.settings` slots. Each installed view declares its
own HTML entrypoint. Contributions sort by numeric `order`, then owner ID and
view ID. Dialogs are opened by a command or from the plugin directory; other
slots mount while enabled. Settings views get individual sections. A command
can instead invoke a worker using `action: { "method": "analyze" }`; its
parameters are `{ threadId, cwd, args }`. Core commands take precedence over
installed commands with the same name. Duplicate plugin commands resolve in
registry order. Use a distinctive command name.

### Left and right panes

Add a view to `contributions.views` with `slot: "pane.left"` for a left navigation
entry or `slot: "pane.right"` for a tool in the right pane's Start tab.
Both use the same sandbox and browser SDK as dialog views. For example:

```json
{
  "id": "notes",
  "title": "Notes",
  "description": "Workspace notes",
  "slot": "pane.right",
  "entrypoint": "notes.html",
  "order": 70
}
```

A command targeting that view opens its pane. Titles are shown in navigation
and optional descriptions appear in the right guide. Each pane view fills its
available space, including in a split. Use `context.read` for the current thread
and working directory. The browser SDK emits a `context` event when either changes.
The `app.sidebar` slot remains an always-visible sidebar
accessory. A selectable pane view mounts when opened.

To supply the whole pane, register an HTML view in `layout.left` or `layout.right`.
The first enabled package layout for that side wins, sorted by `order`, plugin ID
and view ID. Disabling it reveals the next layout or the enabled built-in layout.
Deck supplies the resize handle, collapse control and More menu. The bundled layouts
host the `pane.left` and `pane.right` entries described above.

Both panes have a **More** menu. **Browse other plugins** opens the plugin
directory. **Create your plugin** starts a new Codex session in the current
workspace with an editable draft for that pane. The user sends the draft.

The standalone [worker SDK](../plugin-sdk/worker.mjs) and
[browser SDK](../plugin-sdk/browser.mjs) ship in the npm package. Copy the
appropriate module into your plugin folder so the package remains self-contained.
For example:

```js
import { definePlugin } from "./worker-sdk.mjs";

definePlugin((ctx) => {
  ctx.provide("example.assistant.analysis", async (method, params, call) => {
    if (method !== "warnings") throw new Error("Unknown method");
    return ctx.services.call("codex-deck.diagnostics", "request", {
      path: `/api/codex/warnings?threadId=${encodeURIComponent(params.threadId)}`,
    });
  });
  ctx.onEvent((event) => {
    /* react to lifecycle events */
  });
  ctx.effect(() => {
    /* release plugin-owned resources on shutdown */
  });
  ctx.handle("host.shutdown", ({ cancel }) => {
    /* persist pending work */
  });
});
```

`ctx` also exposes private `data`, `secrets`, `sessions`, `codex`, `status`,
`http`, `signal`, `interval`, and raw `call` operations. Timers, event handlers,
services and RPC promises are disposed on shutdown or IPC disconnect. The
host still enforces every declared permission. No SDK is required to use the
underlying protocol.

For a browser-only example using a shared built-in service, import
[Session inspector](../examples/deck-plugins/session-inspector/) and run
`/inspect-session`. It declares a view and service dependency without adding
application code. Browser panels use `createDeckPlugin()`, await `ready`, and
call `service(name, method, params)`. Theme updates arrive through `onEvent`.
