import { nativeRecord, type NativeRpc } from "./codex-native";
import { CodexInputError } from "./codex-input-error";

/** Upstream `tui.presets` slots are the single digits 0-9 (TUI order 1..9, 0). */
export const PRESET_SLOTS = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "0",
] as const;
export const PRESET_INPUT_MAX_BYTES = 8_000;

export interface CodexPreset {
  slot: string;
  input: string;
  label: string | null;
  /** Config layer type that defines the slot (`user`, `project`, `system`, ...). */
  source: string | null;
  /** Defined outside the user config; edit its source configuration instead. */
  readOnly: boolean;
  /** Validation error for a preset that upstream would refuse to run. */
  invalidReason: string | null;
}
export interface CodexPresetsSnapshot {
  presets: CodexPreset[];
  /** User config version for optimistic-concurrency writes. */
  version: string | null;
}
export interface CodexPresetInput {
  input: string;
  label?: string | null;
}

/** Mirrors codex-rs/config `QuickDial::validate`. */
export function validatePresetInput(input: unknown): string | null {
  if (typeof input !== "string" || !input.trim())
    return "Preset input cannot be empty.";
  if (input.trimStart().startsWith("!"))
    return "Presets support prompts and slash commands, not shell commands.";
  if (new TextEncoder().encode(input).length > PRESET_INPUT_MAX_BYTES)
    return "Preset input cannot exceed 8,000 UTF-8 bytes.";
  return null;
}

export function isPresetSlot(slot: unknown): slot is string {
  return typeof slot === "string" && /^[0-9]$/.test(slot);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function layerPresets(layer: unknown): Record<string, unknown> | null {
  return record(record(record(record(layer)?.config)?.tui)?.presets);
}

function isEditableLayer(layer: Record<string, unknown> | null): boolean {
  const name = record(layer?.name);
  return name?.type === "user" && (name.profile ?? null) === null;
}

export async function readPresets(
  rpc: NativeRpc,
  cwd?: string | null,
): Promise<CodexPresetsSnapshot> {
  const result = nativeRecord(
    await rpc("config/read", {
      includeLayers: true,
      ...(cwd ? { cwd } : {}),
    }),
  );
  const layers = (Array.isArray(result.layers) ? result.layers : [])
    .map(record)
    .filter((layer): layer is Record<string, unknown> => Boolean(layer))
    .filter((layer) => !layer.disabledReason);
  const effective = record(record(record(result.config)?.tui)?.presets);
  const merged: Record<string, Record<string, unknown>> = {};
  if (effective) {
    for (const [slot, value] of Object.entries(effective)) {
      const dial = record(value);
      if (dial) merged[slot] = dial;
    }
  } else {
    // Older servers may omit `tui` from the effective config; merge the
    // returned layers (high to low) the same way TOML layering would.
    for (const layer of [...layers].reverse()) {
      for (const [slot, value] of Object.entries(layerPresets(layer) ?? {})) {
        const dial = record(value);
        if (dial) merged[slot] = { ...merged[slot], ...dial };
      }
    }
  }
  const presets: CodexPreset[] = [];
  for (const slot of PRESET_SLOTS) {
    const dial = merged[slot];
    if (!dial || typeof dial.input !== "string") continue;
    const definingLayers = layers.filter((layer) =>
      Boolean(layerPresets(layer)?.[slot]),
    );
    const top = definingLayers[0] ?? null;
    const label =
      typeof dial.label === "string" && dial.label.trim() ? dial.label : null;
    presets.push({
      slot,
      input: dial.input,
      label,
      source: (record(top?.name)?.type as string | undefined) ?? null,
      readOnly: top !== null && !isEditableLayer(top),
      invalidReason: validatePresetInput(dial.input),
    });
  }
  const userLayer = layers.find((layer) => isEditableLayer(layer));
  return {
    presets,
    version: typeof userLayer?.version === "string" ? userLayer.version : null,
  };
}

export async function writePreset(
  rpc: NativeRpc,
  slot: string,
  preset: CodexPresetInput | null,
  options: { expectedVersion?: string | null; cwd?: string | null } = {},
): Promise<CodexPresetsSnapshot> {
  if (!isPresetSlot(slot))
    throw new CodexInputError(
      "Preset slot must be a single digit from 0 to 9.",
    );
  if (preset) {
    const reason = validatePresetInput(preset.input);
    if (reason) throw new CodexInputError(reason);
    if (preset.label != null && typeof preset.label !== "string")
      throw new CodexInputError("Preset label must be a string.");
  }
  const current = await readPresets(rpc, options.cwd);
  const existing = current.presets.find((entry) => entry.slot === slot);
  if (existing?.readOnly)
    throw new CodexInputError(
      `Preset ${slot} is defined outside your user config. Edit its source configuration instead.`,
    );
  if (
    options.expectedVersion &&
    current.version &&
    options.expectedVersion !== current.version
  )
    throw new CodexInputError(
      "Presets changed in another window. Review the latest presets and try again.",
    );
  const response = nativeRecord(
    await rpc("config/value/write", {
      keyPath: `tui.presets.${JSON.stringify(slot)}`,
      // An explicit empty label masks labels inherited from lower layers.
      value: preset
        ? { input: preset.input, label: preset.label?.trim() ?? "" }
        : null,
      mergeStrategy: "replace",
      ...(current.version ? { expectedVersion: current.version } : {}),
    }),
  );
  if (typeof response.status !== "string")
    throw new Error("Invalid config/value/write response");
  return readPresets(rpc, options.cwd);
}
