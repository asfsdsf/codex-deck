export interface CodexModelServiceTier {
  id: string;
  name: string;
  description: string;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
export function modelServiceTiers(
  value: unknown,
): CodexModelServiceTier[] | undefined {
  const model = record(value);
  const values = Array.isArray(model.serviceTiers)
    ? model.serviceTiers
    : Array.isArray(model.additionalSpeedTiers)
      ? model.additionalSpeedTiers.map((id) => ({
          id,
          name: id,
          description: "",
        }))
      : null;
  if (!values) return undefined;
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const tier = record(value);
    if (typeof tier.id !== "string" || !tier.id.trim() || seen.has(tier.id))
      return [];
    seen.add(tier.id);
    return [
      {
        id: tier.id,
        name: typeof tier.name === "string" ? tier.name : tier.id,
        description:
          typeof tier.description === "string" ? tier.description : "",
      },
    ];
  });
}
export function constrainServiceTiers(
  tiers: CodexModelServiceTier[],
  config: unknown,
  requirements: unknown,
) {
  const features = record(record(config).config).features;
  const local = record(features);
  const response = record(requirements);
  const policy = record(record(response.requirements).featureRequirements);
  const fast = local.fast_mode !== false && policy.fast_mode !== false;
  const ultra =
    local.ultrafast_mode !== false &&
    policy.ultrafast_mode !== false &&
    (response.supportsIndependentSpeedModes === true || fast);
  return tiers.filter(
    (tier) => tier.id === "flex" || (tier.id === "ultrafast" ? ultra : fast),
  );
}
export function serviceTierAvailable(
  model: { serviceTiers?: CodexModelServiceTier[] } | undefined,
  tier: string,
): boolean {
  if (tier === "default") return true;
  return model?.serviceTiers
    ? model.serviceTiers.some((entry) => entry.id === tier)
    : ["fast", "flex"].includes(tier);
}

// Null explicitly requests the configured/catalog default, instead of preserving
// the last tier persisted in a loaded thread by thread/settings/update.
export function serviceTierOverride(
  model: { serviceTiers?: CodexModelServiceTier[] } | undefined,
  selectedTier: string,
): string | null {
  return selectedTier && serviceTierAvailable(model, selectedTier)
    ? selectedTier
    : null;
}
