import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Check, ChevronDown } from "lucide-react";

export interface CodexValuePickerOption {
  value: string;
  label: string;
  description?: string;
}

export interface CodexValuePickerHandle {
  focus: () => void;
  open: () => void;
}

interface CodexValuePickerProps {
  value: string;
  defaultLabel: string;
  options: CodexValuePickerOption[];
  onChange: (value: string) => void;
  inputAriaLabel: string;
  inputPlaceholder: string;
  className?: string;
  disabled?: boolean;
}

const CodexValuePicker = forwardRef<
  CodexValuePickerHandle,
  CodexValuePickerProps
>(function CodexValuePicker(props, ref) {
  const {
    value,
    defaultLabel,
    options,
    onChange,
    inputAriaLabel,
    inputPlaceholder,
    className = "",
    disabled = false,
  } = props;
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = useId();

  const openPicker = useCallback(() => {
    if (disabled) {
      return;
    }
    setQuery(options.some((option) => option.value === value) ? "" : value);
    setIsOpen(true);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [disabled, options, value]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => triggerRef.current?.focus(),
      open: openPicker,
    }),
    [openPicker],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return options;
    }
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(normalizedQuery) ||
        option.value.toLowerCase().includes(normalizedQuery) ||
        option.description?.toLowerCase().includes(normalizedQuery),
    );
  }, [options, query]);

  const selectValue = useCallback(
    (nextValue: string) => {
      onChange(nextValue);
      setIsOpen(false);
      setQuery("");
      triggerRef.current?.focus();
    },
    [onChange],
  );

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") {
      return;
    }
    const customValue = query.trim();
    if (!customValue) {
      return;
    }
    event.preventDefault();
    selectValue(customValue);
  };

  const selectedOption = options.find((option) => option.value === value);
  const triggerLabel = value ? (selectedOption?.label ?? value) : defaultLabel;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={triggerLabel}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        onClick={openPicker}
        className={`inline-flex h-8 min-w-[140px] items-center justify-between gap-2 rounded border border-zinc-800 bg-zinc-900/70 px-2.5 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-800/80 focus:outline-none focus:ring-1 focus:ring-cyan-500/70 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
        title={value || defaultLabel}
      >
        <span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
        <ChevronDown
          aria-hidden="true"
          className={`h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {isOpen && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={inputAriaLabel}
          className="absolute bottom-full left-0 z-50 mb-2 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded border border-zinc-700 bg-zinc-900 shadow-2xl"
        >
          <div className="border-b border-zinc-800 p-2">
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleInputKeyDown}
              aria-label={inputAriaLabel}
              placeholder={inputPlaceholder}
              className="h-8 w-full rounded border border-zinc-700 bg-zinc-950 px-2.5 text-xs text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-cyan-500/70"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            <button
              type="button"
              role="option"
              aria-selected={!value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectValue("")}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${
                !value ? "bg-cyan-700/25" : "hover:bg-zinc-800/80"
              }`}
            >
              <span className="min-w-0 flex-1 truncate text-zinc-200">
                {defaultLabel}
              </span>
              {!value && <Check aria-hidden="true" className="h-3.5 w-3.5" />}
            </button>

            {filteredOptions.map((option) => {
              const isSelected = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectValue(option.value)}
                  className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors ${
                    isSelected ? "bg-cyan-700/25" : "hover:bg-zinc-800/80"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-zinc-100">
                      {option.label}
                    </span>
                    {option.description && (
                      <span className="mt-0.5 block text-[11px] text-zinc-400">
                        {option.description}
                      </span>
                    )}
                  </span>
                  {isSelected && (
                    <Check
                      aria-hidden="true"
                      className="mt-0.5 h-3.5 w-3.5 shrink-0"
                    />
                  )}
                </button>
              );
            })}

            {query.trim() && (
              <button
                type="button"
                role="option"
                aria-selected={query.trim() === value}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectValue(query.trim())}
                className="flex w-full items-center gap-2 border-t border-zinc-800 px-3 py-2 text-left text-xs text-cyan-300 transition-colors hover:bg-zinc-800/80"
              >
                <span className="min-w-0 flex-1 truncate">
                  Use custom value: {query.trim()}
                </span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

export default CodexValuePicker;
