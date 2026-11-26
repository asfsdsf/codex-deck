# Plugin composition

Deck's shell owns transport, Codex-home routing, session synchronization and the
plugin manager. Features register with the shell as plugins. Bundled features
and installed packages share identity, enablement, contributions and service
discovery. There is one evolving API, without compatibility adapters.

The reference implementations in `third_party/deepseek-harness` and
`pixel-workflow` demonstrate three useful boundaries: a small composition root,
named services instead of imports between features, and registrations whose
lifetime belongs to their plugin. Deck adopts those boundaries while retaining
isolated Node workers and sandboxed browser frames for installed code.

## Host contracts

- A built-in definition contains metadata and `apply(context)`. Its context owns
  routes, services, event subscriptions, abort signals and teardown callbacks.
- Every service has an owner and a name. Calls use JSON methods/parameters so
  native modules, Node workers and browser frames use the same contract.
  Providers disappear on unload; calls in flight are cancelled. A package can
  provide only names in its own namespace. Consumers declare service access.
- Required service dependencies determine readiness, including after provider
  removal and restart. Failures are exposed in the contribution snapshot.
- Commands and views are declarative contributions. Commands open a view or
  invoke the owner's worker. Views can target dialogs, settings, the sidebar,
  session toolbar or session footer. A slot renderer knows no feature IDs.
- Built-ins use bundled React views; installed views use sandboxed HTML. Both
  are selected from the same enabled contribution snapshot. Disabling removes
  their commands, views, services and routes, including already open views.
- Built-in defaults are merged with per-home saved enablement. Required
  infrastructure cannot be disabled or uninstalled; optional built-ins can be
  disabled, retain their data and reappear enabled when switched back on.

## Feature ownership

Diagnostics, Daybreak selection, experimental settings, transcript export,
conversation recaps, usage, translation and memory insights are bundled feature
plugins. Their routes and browser views belong beside their definitions under
`builtin-plugins/`. The plugin manager is required infrastructure. New feature
modules are added to the composition catalog, without adding feature branches
to the shell. Installed plugins need no catalog or shell changes.

## Workspace panes

Left pane and Right pane are bundled layout plugins. The left layout renders
registered navigation entries. Sessions supplies the default conversation list.
Terminal and Workflow contribute navigation and own their corresponding workspace views.
The right layout owns the guide, tab strip, split and fullscreen controls.
Files, Git, Tasks, Skills, Hooks and Process own the tools that render inside it.

Installed packages contribute selectable views using `pane.left` and `pane.right`.
An entry is identified by its owner and view ID, so packages can use the same
local view ID. The browser uses the active home's contribution snapshot to build
both menus and to unmount disabled views. Each split has an independent selection.
Installed views can supply the layout slots `layout.left` and `layout.right`.
An enabled package layout takes precedence over the bundled layout. Either layout
can be disabled. The conversation header provides access to Plugins when the left
pane is disabled. Disabling a workspace UI leaves running terminals and workflows
under the control of their existing backend services.

## Invariants

Each home owns its registries and runtime. Existing SSE notifications and remote
encrypted requests carry plugin changes to all browsers. Service calls cannot
redirect themselves to another home through request parameters. Disable revokes
access before teardown. Session operations preserve live-state checks and home
isolation.

Validation covers lifecycle cleanup, capability and namespace boundaries,
dependency loss/restoration, home isolation, disable/re-enable, native feature
routes, worker-to-worker and browser-to-service calls, and browser contributions.
