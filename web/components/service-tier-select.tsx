import type { CodexModelServiceTier } from "@codex-deck/api";
export default function ServiceTierSelect({
  tiers,
  value,
  onChange,
}: {
  tiers: CodexModelServiceTier[];
  value: string;
  onChange: (value: string) => void;
}) {
  if (!tiers.length) return null;
  return (
    <select
      aria-label="Service tier"
      title={
        tiers.find((tier) => tier.id === value)?.description ||
        "Use the configured or catalog default speed"
      }
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 min-w-0 max-w-[160px] rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-200"
    >
      <option value="">Default speed</option>
      <option value="default">Standard speed</option>
      {tiers.map((tier) => (
        <option key={tier.id} value={tier.id}>
          {tier.name}
        </option>
      ))}
    </select>
  );
}
