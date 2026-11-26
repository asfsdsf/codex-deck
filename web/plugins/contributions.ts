import type {
  DeckPluginContributionsSnapshot,
  DeckPluginView,
} from "../../api/deck-plugin-manifest";
import type { SlashCommandDefinition } from "../slash-commands";

type Plugin = DeckPluginContributionsSnapshot["plugins"][number];

export function pluginCommands(
  plugins: Plugin[],
): Array<SlashCommandDefinition & { pluginId: string; commandId: string }> {
  const seen = new Set<string>();
  return plugins
    .filter((p) => !p.workerError)
    .flatMap((plugin) =>
      (plugin.contributions.commands ?? []).flatMap((command) => {
        const name = `/${command.id}`;
        if (seen.has(name)) return [];
        seen.add(name);
        return [
          {
            name,
            description: command.description,
            supportsInlineArgs: command.supportsInlineArgs,
            pluginId: plugin.id,
            commandId: command.id,
          },
        ];
      }),
    );
}

export function pluginViews(plugins: Plugin[], slot: DeckPluginView["slot"]) {
  return plugins
    .filter((p) => !p.workerError)
    .flatMap((plugin) =>
      (plugin.contributions.views ?? [])
        .filter((view) => view.slot === slot)
        .map((view) => ({ plugin, view })),
    )
    .sort(
      (a, b) =>
        (a.view.order ?? 0) - (b.view.order ?? 0) ||
        a.plugin.id.localeCompare(b.plugin.id) ||
        a.view.id.localeCompare(b.view.id),
    );
}
