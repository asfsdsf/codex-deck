import { memo } from "react";

export interface ComposerPickerItem {
  id: string;
  label: string;
  description?: string;
}

interface ComposerPickerProps {
  ariaLabel: string;
  items: ComposerPickerItem[];
  selectedIndex: number;
  onSelect: (item: ComposerPickerItem) => void;
}

const ComposerPicker = memo(function ComposerPicker(
  props: ComposerPickerProps,
) {
  const { ariaLabel, items, selectedIndex, onSelect } = props;

  return (
    <div
      role="listbox"
      aria-label={ariaLabel}
      className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-lg border border-zinc-700/70 bg-zinc-900/95 shadow-2xl"
    >
      <div className="max-h-64 overflow-y-auto py-1">
        {items.map((item, index) => {
          const isActive = index === selectedIndex;
          return (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={isActive}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => onSelect(item)}
              className={`block w-full px-3 py-2 text-left transition-colors ${
                isActive ? "bg-cyan-700/25" : "hover:bg-zinc-800/80"
              }`}
              title={item.label}
            >
              <div className="text-xs font-medium text-zinc-100">
                {item.label}
              </div>
              {item.description && (
                <div className="mt-0.5 text-[11px] text-zinc-400">
                  {item.description}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
});

export default ComposerPicker;
