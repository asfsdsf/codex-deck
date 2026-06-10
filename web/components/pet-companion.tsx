import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { CodexPetMetadata } from "@codex-deck/api";
import { Circle, CircleDot, X } from "lucide-react";

const PET_POSITION_STORAGE_KEY = "codex-deck:pet-position:v1";
const DEFAULT_SIZE_PX = 92;
const EDGE_MARGIN_PX = 12;

export interface PetPosition {
  x: number;
  y: number;
}

interface PetCompanionProps {
  pet: CodexPetMetadata | null;
  onClose: () => void;
}

interface PetPickerProps {
  open: boolean;
  pets: CodexPetMetadata[];
  currentPetId: string | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onSelect: (petId: string) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
}

interface DragState {
  pointerId: number;
  offsetX: number;
  offsetY: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function readStoredPosition(): PetPosition | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(PET_POSITION_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<PetPosition>;
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") {
      return null;
    }
    return parsed as PetPosition;
  } catch {
    return null;
  }
}

function writeStoredPosition(position: PetPosition): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(PET_POSITION_STORAGE_KEY, JSON.stringify(position));
}

function defaultPosition(size: number): PetPosition {
  if (typeof window === "undefined") {
    return { x: EDGE_MARGIN_PX, y: EDGE_MARGIN_PX };
  }
  return {
    x: Math.max(EDGE_MARGIN_PX, window.innerWidth - size - EDGE_MARGIN_PX),
    y: Math.max(EDGE_MARGIN_PX, window.innerHeight - size - 96),
  };
}

function clampPosition(position: PetPosition, size: number): PetPosition {
  if (typeof window === "undefined") {
    return position;
  }
  return {
    x: clamp(position.x, EDGE_MARGIN_PX, window.innerWidth - size - EDGE_MARGIN_PX),
    y: clamp(position.y, EDGE_MARGIN_PX, window.innerHeight - size - EDGE_MARGIN_PX),
  };
}

function getFrameIndexes(pet: CodexPetMetadata): number[] {
  const idle =
    pet.animations.find((animation) => animation.name === "idle") ??
    pet.animations[0];
  if (!idle || idle.frames.length === 0) {
    return [0];
  }
  return idle.frames.map((frame) => frame.spriteIndex);
}

export const PetCompanion = memo(function PetCompanion({
  pet,
  onClose,
}: PetCompanionProps) {
  const [position, setPosition] = useState<PetPosition>(() =>
    clampPosition(readStoredPosition() ?? defaultPosition(DEFAULT_SIZE_PX), DEFAULT_SIZE_PX),
  );
  const [frameIndex, setFrameIndex] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const frameIndexes = useMemo(() => (pet ? getFrameIndexes(pet) : [0]), [pet]);
  const spriteIndex = frameIndexes[frameIndex % frameIndexes.length] ?? 0;
  const column = pet ? spriteIndex % pet.columns : 0;
  const row = pet ? Math.floor(spriteIndex / pet.columns) : 0;

  useEffect(() => {
    setFrameIndex(0);
  }, [pet?.id]);

  useEffect(() => {
    if (!pet) {
      return;
    }
    const idle =
      pet.animations.find((animation) => animation.name === "idle") ??
      pet.animations[0];
    const delay =
      idle?.frames[frameIndex % Math.max(1, idle.frames.length)]?.delayMs ?? 130;
    const timeout = window.setTimeout(() => {
      setFrameIndex((current) => current + 1);
    }, delay);
    return () => window.clearTimeout(timeout);
  }, [frameIndex, pet]);

  useEffect(() => {
    const handleResize = () => {
      setPosition((current) => {
        const next = clampPosition(current, DEFAULT_SIZE_PX);
        writeStoredPosition(next);
        return next;
      });
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const updatePosition = useCallback((next: PetPosition) => {
    const clamped = clampPosition(next, DEFAULT_SIZE_PX);
    setPosition(clamped);
    writeStoredPosition(clamped);
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        offsetX: event.clientX - position.x,
        offsetY: event.clientY - position.y,
      };
      setContextMenu(null);
    },
    [position.x, position.y],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      updatePosition({
        x: event.clientX - drag.offsetX,
        y: event.clientY - drag.offsetY,
      });
    },
    [updatePosition],
  );

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", close);
    };
  }, [contextMenu]);

  if (!pet || !pet.spritesheetUrl) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        className="fixed z-50 touch-none rounded-md outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-cyan-300"
        style={{
          left: position.x,
          top: position.y,
          width: DEFAULT_SIZE_PX,
          height: DEFAULT_SIZE_PX,
        }}
        aria-label={`${pet.displayName} pet`}
        title={pet.displayName}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <span
          className="block h-full w-full bg-no-repeat drop-shadow-[0_10px_18px_rgba(0,0,0,0.35)]"
          style={{
            backgroundImage: `url("${pet.spritesheetUrl}")`,
            backgroundSize: `${pet.columns * DEFAULT_SIZE_PX}px ${pet.rows * DEFAULT_SIZE_PX}px`,
            backgroundPosition: `-${column * DEFAULT_SIZE_PX}px -${row * DEFAULT_SIZE_PX}px`,
            imageRendering: "auto",
          }}
        />
      </button>
      {contextMenu && (
        <div
          className="fixed z-[60] min-w-36 rounded-md border border-zinc-700 bg-zinc-900/96 py-1 text-sm text-zinc-100 shadow-2xl"
          style={{
            left: clamp(contextMenu.x, EDGE_MARGIN_PX, window.innerWidth - 164),
            top: clamp(contextMenu.y, EDGE_MARGIN_PX, window.innerHeight - 52),
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-zinc-800"
            onClick={() => {
              setContextMenu(null);
              onClose();
            }}
          >
            <X className="h-4 w-4" />
            Close pet
          </button>
        </div>
      )}
    </>
  );
});

export const PetPicker = memo(function PetPicker({
  open,
  pets,
  currentPetId,
  loading,
  error,
  onClose,
  onSelect,
}: PetPickerProps) {
  const [query, setQuery] = useState("");
  const visiblePets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return pets;
    }
    return pets.filter((pet) =>
      [pet.id, pet.displayName, pet.description ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    );
  }, [pets, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
    }
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/55 p-4 sm:items-center"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="w-full max-w-lg rounded-xl border border-zinc-700 bg-zinc-900/95 shadow-2xl backdrop-blur">
        <div className="border-b border-zinc-800 px-4 py-3">
          <div className="text-sm font-semibold text-zinc-100">Select Pet</div>
          <div className="mt-1 text-xs text-zinc-400">
            Choose a pet to wake in codex-deck.
          </div>
        </div>
        <div className="space-y-3 p-4">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type to filter pets..."
            autoFocus
            className="w-full rounded border border-zinc-700 bg-zinc-900/70 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {loading ? (
              <div className="rounded border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-xs text-zinc-400">
                Loading pets...
              </div>
            ) : error ? (
              <div className="rounded border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-200">
                {error}
              </div>
            ) : visiblePets.length === 0 ? (
              <div className="rounded border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-xs text-zinc-400">
                No pets match.
              </div>
            ) : (
              visiblePets.map((pet) => {
                const selected = currentPetId === pet.id;
                return (
                  <button
                    key={pet.id}
                    type="button"
                    onClick={() => onSelect(pet.id)}
                    className={`flex w-full items-center gap-3 rounded border px-3 py-2 text-left transition-colors ${
                      selected
                        ? "border-cyan-500/55 bg-cyan-500/16 text-cyan-50"
                        : "border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800/80"
                    }`}
                  >
                    {selected ? (
                      <CircleDot className="h-4 w-4 shrink-0" />
                    ) : (
                      <Circle className="h-4 w-4 shrink-0 text-zinc-600" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm">{pet.displayName}</span>
                      {pet.description ? (
                        <span className="mt-0.5 block truncate text-xs text-zinc-400">
                          {pet.description}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
        <div className="flex justify-end border-t border-zinc-800 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
});
