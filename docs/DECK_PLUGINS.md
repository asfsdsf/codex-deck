# Codex Deck plugin registry

Open **Plugins** from the sidebar or enter /plugins. The floating window lists Codex plugins and Codex Deck plugins, labeled by system. Codex plugin management continues to use the Codex marketplace. Codex Deck entries are imported manifests; they can be enabled, disabled, replaced, and uninstalled.

Codex Deck manifests contain plugin metadata only. Codex Deck does not run plugin code or add plugin controls to the composer.

## Manifest format

Save a JSON file and use **Import manifest** in the Codex Deck plugins section.

```json
{
  "schemaVersion": 1,
  "id": "example.release-notes",
  "name": "Release Notes",
  "version": "1.0.0",
  "description": "Release notes plugin metadata.",
  "author": "Example team"
}
```

Use a stable ID with lowercase letters, digits, dots, or hyphens. The `codex-deck.` prefix is reserved for legacy bundled entries. A manifest can be at most 128 KiB.

Installed manifests are stored at `<selected codex home>/codex-deck/plugins.json`. A replacement must use the same ID and a different version; the directory shows the version before installation. The enabled state is retained when replacing a manifest.

This registry is separate from Codex's plugin implementation. It currently manages Codex Deck plugin metadata and lifecycle only.

The combined directory and separate plugin source labels draw on [ChatGPT apps](https://openai.com/index/introducing-apps-in-chatgpt/) and the plugin catalog patterns in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-plugin-manager/README.md).
