import {
  nativePages,
  nativeRecord,
  readExperimentalFeatures,
  type NativeRpc,
} from "./codex-native";
export type CyberProgram = "standard" | "daybreakBlue" | "daybreakRed";
export interface DaybreakState {
  enabled: boolean;
  eligible: boolean;
  model: string | null;
  models: { id: string; name: string; programs: CyberProgram[] }[];
  reason: string | null;
}
export function selectCyberProgram(
  state: DaybreakState,
  enabled = state.enabled,
  modelId = state.model,
): CyberProgram | null {
  if (!state.eligible) {
    if (enabled)
      throw new Error(
        state.reason || "Daybreak eligibility could not be confirmed.",
      );
    return null;
  }
  const model = state.models.find((entry) => entry.id === modelId);
  if (enabled) {
    const selected = (["daybreakBlue", "daybreakRed"] as const).find(
      (program) => model?.programs.includes(program),
    );
    if (!selected)
      throw new Error(
        `Daybreak support for model ${modelId || "unknown"} could not be confirmed. Turn Daybreak off or select a compatible model.`,
      );
    return selected;
  }
  return model?.programs.includes("standard") ? "standard" : null;
}
export async function readDaybreak(
  rpc: NativeRpc,
  threadId: string,
  modelOverride?: string | null,
  providerOverride?: string | null,
): Promise<DaybreakState> {
  const source = nativeRecord(
    nativeRecord(await rpc("thread/read", { threadId, includeTurns: false }))
      .thread,
  );
  const config = nativeRecord(
    nativeRecord(
      await rpc("config/read", {
        includeLayers: false,
        ...(typeof source.cwd === "string" ? { cwd: source.cwd } : {}),
      }),
    ).config,
  );
  const enabled =
    typeof source.daybreakEnabled === "boolean"
      ? source.daybreakEnabled
      : config.daybreak === true;
  const model =
    modelOverride || (typeof config.model === "string" ? config.model : null);
  const provider =
    providerOverride ||
    config.model_provider ||
    source.modelProvider ||
    "openai";
  const state: DaybreakState = {
    enabled,
    eligible: false,
    model,
    models: [],
    reason: null,
  };
  if (source.ephemeral === true)
    return {
      ...state,
      reason: "Daybreak selection is unavailable for ephemeral conversations.",
    };
  try {
    const [accountResult, features, models] = await Promise.all([
      rpc("account/read", {}),
      readExperimentalFeatures(rpc, threadId),
      nativePages<Record<string, unknown>>(rpc, "model/list", {}),
    ]);
    const account = nativeRecord(accountResult).account;
    const auth =
      account && typeof account === "object"
        ? (account as Record<string, unknown>).type
        : null;
    const featureOn = (name: string) =>
      features.some((entry) => entry.name === name && entry.enabled);
    if (
      provider !== "openai" ||
      !featureOn("cli_daybreak") ||
      !(
        auth === "chatgpt" ||
        (auth === "apiKey" && featureOn("api_key_cyber_access_programs"))
      )
    )
      return {
        ...state,
        reason:
          "Daybreak requires the OpenAI provider, eligible sign-in, and enabled Daybreak support.",
      };
    state.eligible = true;
    state.models = models.flatMap((entry) => {
      const id =
        typeof entry.model === "string"
          ? entry.model
          : typeof entry.id === "string"
            ? entry.id
            : null;
      const programs =
        entry.availableAccessPrograms &&
        typeof entry.availableAccessPrograms === "object"
          ? (entry.availableAccessPrograms as Record<string, unknown>).cyber
          : null;
      return id
        ? [
            {
              id,
              name:
                typeof entry.displayName === "string" ? entry.displayName : id,
              programs: Array.isArray(programs)
                ? programs.filter((program): program is CyberProgram =>
                    ["standard", "daybreakBlue", "daybreakRed"].includes(
                      program,
                    ),
                  )
                : [],
            },
          ]
        : [];
    });
    if (!state.model)
      state.model =
        state.models.find((entry) =>
          models.some(
            (raw) =>
              raw.isDefault === true &&
              (raw.model === entry.id || raw.id === entry.id),
          ),
        )?.id ?? null;
    if (
      !state.models.some((entry) =>
        entry.programs.some((program) => program !== "standard"),
      )
    )
      state.reason =
        "Daybreak availability could not be confirmed by the model catalog.";
  } catch (reason) {
    state.reason = `Daybreak discovery unavailable: ${reason instanceof Error ? reason.message : String(reason)}`;
    state.eligible = false;
  }
  return state;
}
