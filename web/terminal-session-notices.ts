export const TERMINAL_RESTART_BOUND_SESSION_NOTICE =
  "Terminal context notice: The terminal session was restarted. Shell state such as environment variables, aliases, and running processes may have been lost. Do not respond to or act on this notice.";

type RestartNoticePayload = {
  text: string;
  images: string[];
};

type RestartNoticeOptions = {
  sessionIdOverride: string;
  cwdOverride: string | null;
};

export async function sendTerminalRestartNoticeToBoundSession(input: {
  boundSessionId?: string | null;
  cwd?: string | null;
  sendMessage: (
    payload: RestartNoticePayload,
    options: RestartNoticeOptions,
  ) => Promise<boolean>;
}): Promise<boolean> {
  const sessionId = input.boundSessionId?.trim();
  if (!sessionId) {
    return false;
  }

  return input.sendMessage(
    {
      text: TERMINAL_RESTART_BOUND_SESSION_NOTICE,
      images: [],
    },
    {
      sessionIdOverride: sessionId,
      cwdOverride: input.cwd?.trim() || null,
    },
  );
}
