import { memo, useMemo } from "react";
import type { SlashCommandDefinition } from "../slash-commands";
import ComposerPicker, { type ComposerPickerItem } from "./composer-picker";

interface SlashCommandPaletteProps {
  commands: SlashCommandDefinition[];
  selectedIndex: number;
  onSelect: (command: SlashCommandDefinition) => void;
}

const SlashCommandPalette = memo(function SlashCommandPalette(
  props: SlashCommandPaletteProps,
) {
  const { commands, selectedIndex, onSelect } = props;
  const items = useMemo<ComposerPickerItem[]>(
    () =>
      commands.map((command) => ({
        id: command.name,
        label: command.name,
        description: command.description,
      })),
    [commands],
  );
  const commandMap = useMemo(
    () => new Map(commands.map((command) => [command.name, command])),
    [commands],
  );

  return (
    <ComposerPicker
      ariaLabel="Slash commands"
      items={items}
      selectedIndex={selectedIndex}
      onSelect={(item) => {
        const command = commandMap.get(item.id);
        if (command) {
          onSelect(command);
        }
      }}
    />
  );
});

export default SlashCommandPalette;
