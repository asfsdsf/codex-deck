import type {
  DeckPluginContributionsSnapshot,
  DeckPluginView,
} from "../../api/deck-plugin-manifest";
import type { DeckPluginViewContext } from "../../builtin-plugins/client-types";
import { pluginViews } from "./contributions";
import DeckPluginRuntime from "../components/deck-plugin-runtime";

/** All slot content is owned by the contributing plugin. */
export function DeckPluginSlot({
  plugins,
  slot,
  homeId,
  context,
}: {
  plugins: DeckPluginContributionsSnapshot["plugins"];
  slot: DeckPluginView["slot"];
  homeId: string;
  context: DeckPluginViewContext;
}) {
  return (
    <>
      {pluginViews(plugins, slot).map(({ plugin, view }) => (
        <DeckPluginRuntime
          embedded
          key={`${homeId}:${plugin.id}:${view.id}`}
          pluginId={plugin.id}
          viewId={view.id}
          homeId={homeId}
          context={context}
          onClose={() => {}}
        />
      ))}
    </>
  );
}
