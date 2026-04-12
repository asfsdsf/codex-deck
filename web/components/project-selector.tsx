import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import {
  buildProjectSelectorOptions,
  filterProjectSelectorOptions,
} from "../project-selector-utils";

interface ProjectSelectorProps {
  projects: string[];
  selectedProject: string | null;
  onSelectProject: (project: string | null) => void;
  buttonId?: string;
  allLabel?: string;
  searchPlaceholder?: string;
  ariaLabel?: string;
  noMatchLabel?: string;
}

const ProjectSelector = memo(function ProjectSelector(
  props: ProjectSelectorProps,
) {
  const {
    projects,
    selectedProject,
    onSelectProject,
    buttonId,
    allLabel = "All Projects",
    searchPlaceholder = "Type to narrow projects...",
    ariaLabel = "Projects",
    noMatchLabel = "No projects match this search.",
  } = props;
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();

  const availableProjects = useMemo(() => {
    if (selectedProject && !projects.includes(selectedProject)) {
      return [selectedProject, ...projects];
    }
    return projects;
  }, [projects, selectedProject]);

  const options = useMemo(
    () => buildProjectSelectorOptions(availableProjects, allLabel),
    [allLabel, availableProjects],
  );
  const filteredOptions = useMemo(
    () => filterProjectSelectorOptions(options, query),
    [options, query],
  );
  const selectedOption = useMemo(
    () =>
      options.find((option) => option.project === selectedProject) ??
      options[0],
    [options, selectedProject],
  );

  const closeSelector = useCallback(() => {
    setIsOpen(false);
    setQuery("");
  }, []);

  const openSelector = useCallback(() => {
    setIsOpen(true);
    setQuery("");
    const selectedIndex = options.findIndex(
      (option) => option.project === selectedProject,
    );
    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [options, selectedProject]);

  const focusButton = useCallback(() => {
    requestAnimationFrame(() => {
      buttonRef.current?.focus();
    });
  }, []);

  const selectProject = useCallback(
    (project: string | null) => {
      onSelectProject(project);
      closeSelector();
      focusButton();
    },
    [closeSelector, focusButton, onSelectProject],
  );

  useEffect(() => {
    if (!isOpen) {
      optionRefs.current = [];
      return;
    }

    const handlePointerDownOutside = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (!containerRef.current?.contains(target)) {
        closeSelector();
      }
    };

    document.addEventListener("mousedown", handlePointerDownOutside);
    document.addEventListener("touchstart", handlePointerDownOutside);
    return () => {
      document.removeEventListener("mousedown", handlePointerDownOutside);
      document.removeEventListener("touchstart", handlePointerDownOutside);
    };
  }, [closeSelector, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || filteredOptions.length === 0) {
      return;
    }
    setHighlightedIndex((current) =>
      Math.min(current, filteredOptions.length - 1),
    );
  }, [filteredOptions.length, isOpen]);

  useEffect(() => {
    if (!isOpen || filteredOptions.length === 0) {
      return;
    }
    optionRefs.current[highlightedIndex]?.scrollIntoView({
      block: "nearest",
    });
  }, [filteredOptions.length, highlightedIndex, isOpen]);

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        aria-haspopup="listbox"
        aria-controls={isOpen ? listboxId : undefined}
        aria-expanded={isOpen}
        onClick={() => {
          if (isOpen) {
            closeSelector();
            return;
          }
          openSelector();
        }}
        onKeyDown={(event) => {
          if (
            event.key === "ArrowDown" ||
            event.key === "ArrowUp" ||
            event.key === "Enter" ||
            event.key === " "
          ) {
            event.preventDefault();
            openSelector();
          }
        }}
        className="flex min-h-10 w-full items-center gap-2 rounded border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-left text-sm text-zinc-300 transition-colors hover:bg-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
        title={selectedProject ?? allLabel}
      >
        <span className="min-w-0 flex-1 truncate">{selectedOption.label}</span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {isOpen && (
        <div className="absolute left-0 right-0 z-30 mt-2 overflow-hidden rounded-lg border border-zinc-700/70 bg-zinc-950/95 shadow-2xl">
          <div className="border-b border-zinc-800/70 p-2">
            <div className="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900/70 px-2.5">
              <Search className="h-4 w-4 shrink-0 text-zinc-500" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setHighlightedIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeSelector();
                    focusButton();
                    return;
                  }
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setHighlightedIndex((current) =>
                      Math.min(current + 1, filteredOptions.length - 1),
                    );
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setHighlightedIndex((current) => Math.max(current - 1, 0));
                    return;
                  }
                  if (event.key === "Enter") {
                    const nextOption = filteredOptions[highlightedIndex];
                    if (nextOption) {
                      event.preventDefault();
                      selectProject(nextOption.project);
                    }
                  }
                }}
                placeholder={searchPlaceholder}
                className="h-10 min-w-0 flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setHighlightedIndex(0);
                    inputRef.current?.focus();
                  }}
                  className="text-zinc-500 transition-colors hover:text-zinc-300"
                  aria-label="Clear project search"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          <div
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel}
            className="max-h-72 overflow-y-auto py-1"
          >
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-zinc-500">
                {noMatchLabel}
              </div>
            ) : (
              filteredOptions.map((option, index) => {
                const isSelected = option.project === selectedProject;
                const isHighlighted = index === highlightedIndex;
                return (
                  <button
                    key={option.project ?? "__all-projects__"}
                    ref={(element) => {
                      optionRefs.current[index] = element;
                    }}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={isSelected}
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    onMouseEnter={() => {
                      setHighlightedIndex(index);
                    }}
                    onClick={() => {
                      selectProject(option.project);
                    }}
                    className={`flex w-full items-start gap-3 px-3 py-2 text-left transition-colors ${
                      isHighlighted ? "bg-cyan-700/20" : "hover:bg-zinc-800/80"
                    }`}
                    title={option.description ?? option.label}
                  >
                    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                      {isSelected && (
                        <Check className="h-4 w-4 text-cyan-300" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-zinc-100">
                        {option.label}
                      </span>
                      {option.description && (
                        <span className="mt-0.5 block truncate text-[11px] text-zinc-500">
                          {option.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
});

export default ProjectSelector;
