import { memo, useMemo } from "react";
import ComposerPicker, { type ComposerPickerItem } from "./composer-picker";

export interface SkillSelectorItem {
  name: string;
  description?: string;
}

interface SkillSelectorPaletteProps {
  skills: SkillSelectorItem[];
  selectedIndex: number;
  onSelect: (skill: SkillSelectorItem) => void;
}

const SkillSelectorPalette = memo(function SkillSelectorPalette(
  props: SkillSelectorPaletteProps,
) {
  const { skills, selectedIndex, onSelect } = props;

  const items = useMemo<ComposerPickerItem[]>(
    () =>
      skills.map((skill) => ({
        id: skill.name,
        label: `$${skill.name}`,
        description: skill.description,
      })),
    [skills],
  );

  const skillMap = useMemo(
    () => new Map(skills.map((skill) => [skill.name, skill])),
    [skills],
  );

  return (
    <ComposerPicker
      ariaLabel="Skills"
      items={items}
      selectedIndex={selectedIndex}
      onSelect={(item) => {
        const skill = skillMap.get(item.id);
        if (skill) {
          onSelect(skill);
        }
      }}
    />
  );
});

export default SkillSelectorPalette;
