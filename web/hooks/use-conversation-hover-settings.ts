import { useEffect, useState } from "react";
import {
  DEFAULT_CONVERSATION_HOVER_SETTINGS,
  resolveConversationHoverSettings,
} from "../../api/conversation-hover-settings";
import { subscribeConversationHoverSettings } from "../transport";
import { usePageVisibility } from "./use-page-visibility";

export function useConversationHoverSettings(enabled = true) {
  const [settings, setSettings] = useState(DEFAULT_CONVERSATION_HOVER_SETTINGS);
  const isPageVisible = usePageVisibility();
  useEffect(
    () =>
      enabled && isPageVisible
        ? subscribeConversationHoverSettings({
            onSettings: (next) =>
              setSettings((previous) => {
                const resolved = resolveConversationHoverSettings(next);
                return JSON.stringify(previous) === JSON.stringify(resolved)
                  ? previous
                  : resolved;
              }),
          })
        : undefined,
    [isPageVisible, enabled],
  );
  return settings;
}
