export function detectMobilePhone(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const mobileNavigator = window.navigator as Navigator & {
    userAgentData?: { mobile?: boolean };
  };
  if (mobileNavigator.userAgentData?.mobile === true) {
    return true;
  }

  const userAgent = mobileNavigator.userAgent || "";
  if (
    /Android.*Mobile|iPhone|iPod|Windows Phone|IEMobile|Opera Mini/i.test(
      userAgent,
    )
  ) {
    return true;
  }
  if (/iPad/i.test(userAgent)) {
    return false;
  }

  const hasTouch = (mobileNavigator.maxTouchPoints ?? 0) > 0;
  const isCoarsePointer =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
  const shortestViewport = Math.min(window.innerWidth, window.innerHeight);
  return hasTouch && isCoarsePointer && shortestViewport <= 768;
}
