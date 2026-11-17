import {
  useState,
  useEffect,
  useCallback,
  type FormEvent as ReactFormEvent,
} from "react";
import {
  createRemoteAdminSetupToken,
  deleteRemoteAdminSetupToken,
  listRemoteAdminSetupTokens,
  loginRemoteAdmin,
  logoutRemoteAdmin,
  type RemoteAdminSetupToken,
  regenerateRemoteAdminSetupToken,
  rotateRemoteAdminPassword,
  updateRemoteAdminSetupToken,
} from "../api";
import PasswordField from "./password-field";

function formatAdminTimestamp(timestamp: number | null): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return "Never";
  }
  return new Date(timestamp).toLocaleString();
}

export default function RemoteAdminApp({ serverUrl }: { serverUrl: string }) {
  const [password, setPassword] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [tokenLabel, setTokenLabel] = useState("");
  const [tokens, setTokens] = useState<RemoteAdminSetupToken[]>([]);
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [workingTokenId, setWorkingTokenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealedToken, setRevealedToken] = useState<{
    label: string;
    rawToken: string;
  } | null>(null);

  const refreshTokens = useCallback(async () => {
    const nextTokens = await listRemoteAdminSetupTokens(serverUrl);
    setTokens(nextTokens);
    setAuthenticated(true);
  }, [serverUrl]);

  useEffect(() => {
    let cancelled = false;
    void refreshTokens()
      .catch(() => {
        if (!cancelled) {
          setAuthenticated(false);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTokens]);

  const handleLogin = useCallback(
    async (event: ReactFormEvent) => {
      event.preventDefault();
      if (submitting) {
        return;
      }

      setSubmitting(true);
      setError(null);
      try {
        await loginRemoteAdmin(serverUrl, password);
        await refreshTokens();
        setPassword("");
      } catch (loginError) {
        setAuthenticated(false);
        setError(
          loginError instanceof Error ? loginError.message : String(loginError),
        );
      } finally {
        setSubmitting(false);
      }
    },
    [password, refreshTokens, serverUrl, submitting],
  );

  const handleLogout = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      await logoutRemoteAdmin(serverUrl);
    } catch (logoutError) {
      setError(
        logoutError instanceof Error
          ? logoutError.message
          : String(logoutError),
      );
    } finally {
      setTokens([]);
      setAuthenticated(false);
      setSubmitting(false);
    }
  }, [serverUrl]);

  const handleCreateToken = useCallback(async () => {
    if (submitting) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const created = await createRemoteAdminSetupToken(serverUrl, tokenLabel);
      setTokenLabel("");
      setRevealedToken({
        label: created.token.label,
        rawToken: created.rawToken,
      });
      await refreshTokens();
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : String(createError),
      );
    } finally {
      setSubmitting(false);
    }
  }, [refreshTokens, serverUrl, submitting, tokenLabel]);

  const handleRenameToken = useCallback(
    async (token: RemoteAdminSetupToken) => {
      const nextLabel =
        typeof window !== "undefined"
          ? window.prompt("Rename setup token", token.label)
          : token.label;
      if (!nextLabel || nextLabel.trim() === token.label) {
        return;
      }

      setWorkingTokenId(token.id);
      setError(null);
      try {
        await updateRemoteAdminSetupToken(serverUrl, token.id, {
          label: nextLabel.trim(),
        });
        await refreshTokens();
      } catch (updateError) {
        setError(
          updateError instanceof Error
            ? updateError.message
            : String(updateError),
        );
      } finally {
        setWorkingTokenId(null);
      }
    },
    [refreshTokens, serverUrl],
  );

  const handleToggleToken = useCallback(
    async (token: RemoteAdminSetupToken) => {
      setWorkingTokenId(token.id);
      setError(null);
      try {
        await updateRemoteAdminSetupToken(serverUrl, token.id, {
          enabled: !token.enabled,
        });
        await refreshTokens();
      } catch (updateError) {
        setError(
          updateError instanceof Error
            ? updateError.message
            : String(updateError),
        );
      } finally {
        setWorkingTokenId(null);
      }
    },
    [refreshTokens, serverUrl],
  );

  const handleRegenerateToken = useCallback(
    async (token: RemoteAdminSetupToken) => {
      setWorkingTokenId(token.id);
      setError(null);
      try {
        const regenerated = await regenerateRemoteAdminSetupToken(
          serverUrl,
          token.id,
        );
        setRevealedToken({
          label: regenerated.token.label,
          rawToken: regenerated.rawToken,
        });
        await refreshTokens();
      } catch (regenerateError) {
        setError(
          regenerateError instanceof Error
            ? regenerateError.message
            : String(regenerateError),
        );
      } finally {
        setWorkingTokenId(null);
      }
    },
    [refreshTokens, serverUrl],
  );

  const handleDeleteToken = useCallback(
    async (token: RemoteAdminSetupToken) => {
      const confirmed =
        typeof window === "undefined"
          ? true
          : window.confirm(`Delete setup token "${token.label}"?`);
      if (!confirmed) {
        return;
      }

      setWorkingTokenId(token.id);
      setError(null);
      try {
        await deleteRemoteAdminSetupToken(serverUrl, token.id);
        await refreshTokens();
      } catch (deleteError) {
        setError(
          deleteError instanceof Error
            ? deleteError.message
            : String(deleteError),
        );
      } finally {
        setWorkingTokenId(null);
      }
    },
    [refreshTokens, serverUrl],
  );

  const handleRotatePassword = useCallback(async () => {
    if (!oldPassword || !newPassword || !confirmNewPassword || submitting) {
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setError("New passwords do not match.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await rotateRemoteAdminPassword(serverUrl, oldPassword, newPassword);
      setOldPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
    } catch (rotateError) {
      setError(
        rotateError instanceof Error
          ? rotateError.message
          : String(rotateError),
      );
    } finally {
      setSubmitting(false);
    }
  }, [confirmNewPassword, newPassword, oldPassword, serverUrl, submitting]);

  if (loading) {
    return (
      <div className="app-viewport-min-height app-viewport-safe-area flex items-center justify-center bg-zinc-950 px-6 text-zinc-100">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 px-6 py-5 text-sm text-zinc-300 shadow-2xl">
          Loading admin console...
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="app-viewport-min-height app-viewport-safe-area flex items-center justify-center bg-zinc-950 px-6 text-zinc-100">
        <form
          onSubmit={handleLogin}
          className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/80 p-6 shadow-2xl"
        >
          <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">
            codex-deck
          </div>
          <h1 className="mt-3 text-2xl font-semibold text-zinc-50">
            Server Admin
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Log in with the server admin password to manage setup tokens and
            rotate the admin password.
          </p>
          <PasswordField
            label="Admin Password"
            value={password}
            onChange={setPassword}
            placeholder="Enter admin password"
            autoComplete="current-password"
            containerClassName="mt-6 block space-y-1"
          />
          {error && (
            <div className="mt-4 rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}
          <div className="mt-6 flex items-center justify-between gap-3">
            <a
              href={serverUrl}
              className="text-xs text-zinc-500 transition-colors hover:text-zinc-300"
            >
              Back To App
            </a>
            <button
              type="submit"
              disabled={submitting || password.length === 0}
              className="h-10 rounded border border-cyan-700/60 bg-cyan-700/30 px-4 text-sm text-cyan-50 transition-colors hover:bg-cyan-700/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Working..." : "Login"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="app-viewport-min-height app-viewport-safe-area bg-zinc-950 px-6 py-10 text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">
              codex-deck
            </div>
            <h1 className="mt-2 text-3xl font-semibold text-zinc-50">
              Server Admin
            </h1>
            <p className="mt-2 text-sm text-zinc-400">
              Manage CLI setup tokens and rotate the server admin password.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <a
              href={serverUrl}
              className="h-10 rounded border border-zinc-700 bg-zinc-800/80 px-4 text-sm text-zinc-200 transition-colors hover:bg-zinc-700/80"
            >
              Open App
            </a>
            <button
              type="button"
              onClick={() => {
                void handleLogout();
              }}
              className="h-10 rounded border border-zinc-700 bg-zinc-800/80 px-4 text-sm text-zinc-200 transition-colors hover:bg-zinc-700/80"
            >
              Logout
            </button>
          </div>
        </div>

        {revealedToken && (
          <div className="rounded-xl border border-amber-800/60 bg-amber-950/30 px-4 py-4 text-sm text-amber-100">
            <div className="font-medium uppercase tracking-[0.16em] text-amber-300">
              Copy This Token Now
            </div>
            <div className="mt-2 text-xs text-amber-200">
              {revealedToken.label}
            </div>
            <div className="mt-3 break-all rounded border border-amber-900/50 bg-zinc-950/60 px-3 py-3 font-mono text-xs text-amber-50">
              {revealedToken.rawToken}
            </div>
          </div>
        )}

        {error && (
          <div className="rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-200">
            {error}
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5 shadow-xl">
            <div className="text-sm font-semibold text-zinc-100">
              Setup Tokens
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              Create tokens for CLI bootstrap. Raw token values are shown only
              once when created or regenerated.
            </p>

            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <input
                type="text"
                value={tokenLabel}
                onChange={(event) => setTokenLabel(event.target.value)}
                placeholder="Optional token label"
                className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-sm text-zinc-100 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => {
                  void handleCreateToken();
                }}
                disabled={submitting}
                className="h-10 rounded border border-cyan-700/60 bg-cyan-700/30 px-4 text-sm text-cyan-50 transition-colors hover:bg-cyan-700/40 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Create Token
              </button>
            </div>

            <div className="mt-5 space-y-3">
              {tokens.length === 0 ? (
                <div className="rounded border border-zinc-800 bg-zinc-950/40 px-3 py-3 text-sm text-zinc-400">
                  No setup tokens are configured.
                </div>
              ) : (
                tokens.map((token) => (
                  <div
                    key={token.id}
                    className="rounded-xl border border-zinc-800 bg-zinc-950/50 px-4 py-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-zinc-100">
                          {token.label}
                        </div>
                        <div className="mt-1 text-xs text-zinc-500">
                          Last used: {formatAdminTimestamp(token.lastUsedAt)}
                        </div>
                      </div>
                      <div className="text-xs uppercase tracking-[0.16em] text-zinc-500">
                        {token.enabled ? "Enabled" : "Disabled"}
                      </div>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          void handleRenameToken(token);
                        }}
                        disabled={workingTokenId === token.id}
                        className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void handleToggleToken(token);
                        }}
                        disabled={workingTokenId === token.id}
                        className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {token.enabled ? "Disable" : "Enable"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void handleRegenerateToken(token);
                        }}
                        disabled={workingTokenId === token.id}
                        className="h-8 rounded border border-cyan-700/60 bg-cyan-700/30 px-3 text-xs text-cyan-50 transition-colors hover:bg-cyan-700/40 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Regenerate
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void handleDeleteToken(token);
                        }}
                        disabled={workingTokenId === token.id}
                        className="h-8 rounded border border-red-900/50 bg-red-950/30 px-3 text-xs text-red-200 transition-colors hover:bg-red-950/45 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5 shadow-xl">
            <div className="text-sm font-semibold text-zinc-100">
              Rotate Admin Password
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              Rotating the password replaces the current admin session.
            </p>
            <PasswordField
              label="Current Password"
              value={oldPassword}
              onChange={setOldPassword}
              placeholder="Enter the current admin password"
              autoComplete="current-password"
              containerClassName="mt-5 block space-y-1"
            />
            <PasswordField
              label="New Password"
              value={newPassword}
              onChange={setNewPassword}
              placeholder="Enter a new admin password"
              autoComplete="new-password"
              containerClassName="mt-4 block space-y-1"
            />
            <PasswordField
              label="Confirm New Password"
              value={confirmNewPassword}
              onChange={setConfirmNewPassword}
              placeholder="Enter the new password again"
              autoComplete="new-password"
              containerClassName="mt-4 block space-y-1"
            />
            <button
              type="button"
              onClick={() => {
                void handleRotatePassword();
              }}
              disabled={
                submitting ||
                oldPassword.length === 0 ||
                newPassword.length === 0 ||
                confirmNewPassword.length === 0 ||
                newPassword !== confirmNewPassword
              }
              className="mt-4 h-10 rounded border border-cyan-700/60 bg-cyan-700/30 px-4 text-sm text-cyan-50 transition-colors hover:bg-cyan-700/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Rotate Password
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
