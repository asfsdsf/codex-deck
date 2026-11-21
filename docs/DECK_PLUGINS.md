# Codex Deck plugins

Open **Plugins** from the sidebar or enter `/plugins`. The floating window lists Codex plugins and Codex Deck plugins, labeled by system. Codex plugin management continues to use the Codex marketplace. A Codex Deck plugin is an installable folder of real files. `plugin.json` declares its identity, API compatibility, capabilities, and panel entrypoint; HTML, JavaScript, styles, and assets live in their own files.

## Package a plugin

Create a folder with this structure:

```text
release-notes/
  plugin.json
  index.html
  styles.css
  panel.js
  assets/
    logo.svg
```

The runnable [Release Notes example](../examples/deck-plugins/release-notes/) is
available in the worktree.

`plugin.json` is package metadata, not the plugin itself:

```json
{
  "schemaVersion": 1,
  "apiVersion": 1,
  "id": "example.release-notes",
  "name": "Release Notes",
  "version": "1.0.0",
  "description": "Keep release notes for the selected project.",
  "author": "Example team",
  "capabilities": ["context.read", "state.read", "state.write"],
  "entrypoints": { "panel": "index.html" }
}
```

`index.html` can refer to other package files using relative paths:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <img src="./assets/logo.svg" alt="" />
    <main id="app"></main>
    <script type="module" src="./panel.js"></script>
  </body>
</html>
```

The browser module in `panel.js` can use the plugin bridge. For example:

```js
const channel = "codex-deck-plugin";
const pending = new Map();
let requestNumber = 0;

function request(method, params) {
  const requestId = String(++requestNumber);
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    parent.postMessage(
      { channel, type: "request", requestId, method, params },
      "*",
    );
  });
}

window.addEventListener("message", async (event) => {
  const message = event.data;
  if (message?.channel !== channel) return;
  if (message.type === "response") {
    const operation = pending.get(message.requestId);
    if (!operation) return;
    pending.delete(message.requestId);
    if (message.error) operation.reject(new Error(message.error));
    else operation.resolve(message.result);
    return;
  }
  if (message.type !== "initialize") return;

  const context = await request("getContext");
  const state = await request("getState");
  document.querySelector("#app").textContent = JSON.stringify({
    threadId: context.threadId,
    project: context.cwd,
    savedState: state,
  });
});
```

Use a stable lowercase ID with letters, digits, dots, and hyphens. Versions use semantic version strings. The `codex-deck.` ID prefix is reserved. The manifest supports API version 1 and these capabilities:

- `context.read` — read the selected thread ID and project path.
- `state.read` — read the plugin's saved JSON data.
- `state.write` — save plugin JSON data.

Only capabilities listed by the package are granted. External network access, Codex tool calls, server-side code, and composer actions are not part of this plugin API. Browser dependencies should be bundled into the package or included as relative modules and assets.

## Install and manage

Choose **Import plugin folder**, select the package directory, and review the displayed source files. Check the review confirmation, then install. The panel opens from the plugin's detail view. An update must keep the same ID, use a different version, and be reviewed before replacing the installed package. Enable, disable, and uninstall controls are available there.

Manifests are limited to 128 KiB. Packages are limited to 8 MiB and 256 files; installed homes are limited to 64 plugins. Import rejects invalid manifests, missing entrypoints, duplicate paths, traversal paths, and reserved directories. The server rejects symbolic links in installed package trees when it reads or serves files.

## Runtime and storage

The panel runs in an iframe with a unique origin and a restrictive Content Security Policy. It can load package files from its own package route but cannot fetch other network resources, open nested frames, access the parent DOM, or use browser storage. The parent and plugin communicate with JSON messages on the `codex-deck-plugin` channel. The host checks the iframe source, granted capability, message size, and request rate before replying.

On iframe load, the host sends `initialize` with plugin metadata, granted capabilities, and only the initial context and state permitted by those capabilities. The plugin may then request:

- `getContext` — the latest selected thread ID and project path, or `null` when unavailable.
- `getState` — the plugin's saved JSON object.
- `setState` with `{ state: { ... } }` — persist up to 64 KiB of JSON for this plugin.

Requests include a unique `requestId`; responses contain the same ID and either `result` or `error`. The bridge accepts at most 60 requests per minute and limits individual messages to 64 KiB.

For this local run, installed package files are under:

```text
<selected Codex home>/codex-deck/plugins/<plugin-id>/
```

Enablement is recorded in `<selected Codex home>/codex-deck/plugins.json`. Plugin data is separate from the code at `<selected Codex home>/codex-deck/plugin-data/<plugin-id>.json`; updates preserve it, while uninstall removes it. The Codex home selected in the sidebar determines which plugin package and state directories the app uses.

Codex Deck plugins are separate from Codex plugins. The package lifecycle and modular extension approach draw on [DeepSeek Harness's plugin manager](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-plugin-manager/README.md) and [package authoring guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-package.md), adapted to run third-party browser code in a sandbox instead of loading it into Codex Deck's host process.
