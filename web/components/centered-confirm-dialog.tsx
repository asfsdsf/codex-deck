import type { ReactNode } from "react";

interface CenteredConfirmDialogProps {
  title: ReactNode;
  message?: ReactNode;
  tone?: "danger" | "warning";
  children?: ReactNode;
}

const TONE_CLASS_NAMES = {
  danger: {
    border: "border-red-700/60",
    title: "text-red-200",
  },
  warning: {
    border: "border-amber-700/60",
    title: "text-amber-200",
  },
} as const;

export default function CenteredConfirmDialog({
  title,
  message,
  tone = "danger",
  children,
}: CenteredConfirmDialogProps) {
  const classNames = TONE_CLASS_NAMES[tone];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
      <div
        role="dialog"
        aria-modal="true"
        className={`w-full max-w-md rounded-xl border ${classNames.border} bg-zinc-900/95 shadow-2xl backdrop-blur`}
      >
        <div className="px-4 py-3">
          <div className={`text-sm font-semibold ${classNames.title}`}>
            {title}
          </div>
          {message ? (
            <p className="mt-2 text-xs leading-relaxed text-zinc-300">
              {message}
            </p>
          ) : null}
          {children}
        </div>
      </div>
    </div>
  );
}
