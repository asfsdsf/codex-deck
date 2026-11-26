import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export const INPUT_CLASS =
  "h-9 w-full rounded border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-500 focus:border-cyan-500 disabled:cursor-not-allowed disabled:opacity-60";
export const SETTINGS_CARD = "rounded-md border bg-zinc-900/45 p-3";
export const REMOVE_BUTTON =
  "h-9 w-8 shrink-0 rounded text-zinc-500 transition-colors hover:bg-red-500/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50";

export function EmptySettingsList({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center border-y border-dashed border-zinc-800 text-zinc-500">
      <Icon className="h-6 w-6" />
      <div className="mt-2 text-xs">{children}</div>
    </div>
  );
}

export function Field({
  label,
  badge,
  error,
  children,
}: {
  label: string;
  badge?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 flex items-center gap-2 text-xs font-medium text-zinc-300">
        <span>{label}</span>
        {badge}
      </span>
      {children}
      {error ? (
        <span className="mt-1.5 block text-[11px] text-red-300" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}
