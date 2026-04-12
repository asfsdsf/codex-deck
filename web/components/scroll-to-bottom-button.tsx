interface ScrollToBottomButtonProps {
  onClick: () => void;
  direction?: "down" | "down-right";
  bottomOffsetPx?: number;
}

function ScrollToBottomButton({
  onClick,
  direction = "down",
  bottomOffsetPx = 16,
}: ScrollToBottomButtonProps) {
  return (
    <button
      onClick={onClick}
      className="absolute right-6 z-20 flex cursor-pointer items-center gap-1.5 rounded-full bg-zinc-200/90 px-3.5 py-2 text-xs font-medium text-zinc-900 shadow-lg backdrop-blur-sm transition-all hover:bg-zinc-100"
      style={{ bottom: `${bottomOffsetPx}px` }}
    >
      <svg
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d={
            direction === "down-right"
              ? "M4 4l16 16m0 0V10m0 10H10"
              : "M19 14l-7 7m0 0l-7-7m7 7V3"
          }
        />
      </svg>
      <span>Latest</span>
    </button>
  );
}

export default ScrollToBottomButton;
