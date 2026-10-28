import { useCallback, useState, type FormEvent } from "react";
import type {
  BedrockDiscovery,
  CodexAccountSnapshot,
} from "../../api/codex-account";
import {
  cancelCodexGatewayLogin,
  cancelCodexLogin,
  configureCodexBedrock,
  discoverCodexBedrock,
  getCodexAccount,
  logoutCodexAccount,
  startCodexGatewayLogin,
  startCodexLogin,
} from "../extensions-api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";

const GOVCLOUD_GUIDE_URL =
  "https://learn.chatgpt.com/docs/enterprise/govcloud-configuration";
const BEDROCK_GUIDE_URL = "https://learn.chatgpt.com/docs/amazon-bedrock";

const button =
  "min-h-9 rounded border border-zinc-700 px-3 py-1.5 text-left disabled:opacity-50";
const primary =
  "min-h-9 rounded bg-cyan-600 px-3 py-1.5 text-white disabled:opacity-50";
const field =
  "min-h-9 w-full min-w-0 rounded border border-zinc-700 bg-zinc-950 px-2";

function accountSummary(snapshot: CodexAccountSnapshot): string {
  const account = snapshot.account;
  if (!account) return "Not signed in";
  if (account.type === "chatgpt" && "email" in account)
    return `Signed in with ChatGPT${account.email ? ` as ${account.email}` : ""}${account.planType ? ` · ${account.planType} plan` : ""}`;
  if (account.type === "apiKey") return "Signed in with an OpenAI API key";
  if (account.type === "amazonBedrock") return "Using Amazon Bedrock";
  return `Signed in (${account.type})`;
}

function MethodButton({
  title,
  description,
  disabled,
  onClick,
}: {
  title: string;
  description: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full flex-col items-start gap-0.5 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3 text-left disabled:opacity-50"
    >
      <span className="font-semibold">{title}</span>
      <span className="text-xs text-zinc-400">{description}</span>
    </button>
  );
}

export default function CodexAccount({
  confirmLogout = false,
}: {
  /** `/logout` opens straight to the logout confirmation. */
  confirmLogout?: boolean;
}) {
  const load = useCallback(() => getCodexAccount(), []);
  const { data, loading, error, refresh, setData } = useNativeSnapshot(
    "account",
    null,
    load,
  );
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [panel, setPanel] = useState<"apiKey" | "bedrock" | null>(null);
  const [logoutPending, setLogoutPending] = useState(confirmLogout);
  const [apiKey, setApiKey] = useState("");
  const [discovery, setDiscovery] = useState<BedrockDiscovery | null>(null);
  const [region, setRegion] = useState("");
  const [bedrockKey, setBedrockKey] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [govCloudWarning, setGovCloudWarning] = useState(false);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      await work();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
      refresh();
    } finally {
      setBusy(false);
    }
  };
  const clearSecrets = () => {
    setApiKey("");
    setBedrockKey("");
    setAccessKeyId("");
    setSecretAccessKey("");
    setSessionToken("");
  };
  const bedrock = (body: Record<string, unknown>) =>
    act(async () => {
      const result = await configureCodexBedrock(body);
      clearSecrets();
      setData(result.snapshot);
      setGovCloudWarning(result.govCloudWarning);
      setPanel(null);
      setNotice(
        "Amazon Bedrock is configured. New conversations use the updated provider.",
      );
    });

  const pending = data?.pendingLogin ?? null;
  const gateway = data?.gateway ?? null;
  const signedIn = Boolean(data?.account);
  const regionValue = region.trim();

  return (
    <div className="space-y-3 text-sm">
      <p className="text-zinc-400">
        Sign in to Codex on the machine running Codex Deck. This is your Codex
        CLI account, separate from Codex Deck remote login.
      </p>
      {(error || actionError) && (
        <p role="alert" className="break-words text-red-400">
          {actionError || error}
        </p>
      )}
      {loading && !data && <p role="status">Loading Codex account…</p>}
      {data && (
        <section className="space-y-2 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3">
          <p className="break-words font-semibold">{accountSummary(data)}</p>
          <p className="break-words text-xs text-zinc-400">
            Model provider: {data.modelProvider ?? "openai"}
            {!data.account && !data.requiresOpenaiAuth
              ? " · This provider does not require an OpenAI account."
              : ""}
          </p>
          {data.errors.map((entry) => (
            <p key={entry} className="break-words text-xs text-amber-300">
              {entry}
            </p>
          ))}
          {data.lastLogin && !pending && (
            <p
              role="status"
              className={
                data.lastLogin.success ? "text-emerald-300" : "text-red-400"
              }
            >
              {data.lastLogin.success
                ? "Sign-in completed. New conversations use this account."
                : `Sign-in failed${data.lastLogin.error ? `: ${data.lastLogin.error}` : "."}`}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || loading}
              className={button}
              onClick={refresh}
            >
              Refresh
            </button>
            {signedIn && (
              <button
                type="button"
                disabled={busy}
                className={button}
                onClick={() => setLogoutPending(true)}
              >
                Log out
              </button>
            )}
          </div>
        </section>
      )}
      {notice && (
        <p role="status" className="text-emerald-300">
          {notice}
        </p>
      )}
      {govCloudWarning && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
          <p className="font-semibold">Using Codex with AWS GovCloud</p>
          <p className="mt-1 text-zinc-300">
            Please ensure you or your administrator have read the{" "}
            <a
              href={GOVCLOUD_GUIDE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-cyan-300 underline"
            >
              application configuration and security guidance
            </a>{" "}
            before proceeding.
          </p>
        </div>
      )}

      {logoutPending && (
        <div
          role="alertdialog"
          aria-label="Confirm Codex logout"
          className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3"
        >
          <p className="font-semibold">Log out of Codex?</p>
          <p className="text-zinc-300">
            This removes the saved Codex credentials on the machine running
            Codex Deck for every client and Codex CLI. Running conversations may
            stop working until you sign in again.
          </p>
          {data && !signedIn && (
            <p className="text-xs text-zinc-400">
              No Codex account is signed in.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !signedIn}
              className="min-h-9 rounded bg-amber-600 px-3 py-1.5 text-white disabled:opacity-50"
              onClick={() =>
                void act(async () => {
                  setData(await logoutCodexAccount());
                  setLogoutPending(false);
                  setNotice("Logged out of Codex.");
                })
              }
            >
              Log out of Codex
            </button>
            <button
              type="button"
              className={button}
              onClick={() => setLogoutPending(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {pending && (
        <section
          aria-live="polite"
          className="space-y-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 p-3"
        >
          {pending.type === "chatgptDeviceCode" ? (
            <>
              <p className="font-semibold">Sign in with Device Code</p>
              <p className="text-zinc-300">
                Open the sign-in page on any device, sign in, and enter this
                one-time code:
              </p>
              <p className="select-all break-all font-mono text-xl tracking-widest">
                {pending.userCode}
              </p>
              {pending.verificationUrl && (
                <a
                  className="break-all text-cyan-300 underline"
                  href={pending.verificationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {pending.verificationUrl}
                </a>
              )}
            </>
          ) : (
            <>
              <p className="font-semibold">
                Finish signing in via your browser
              </p>
              {pending.authUrl && (
                <a
                  className="break-all text-cyan-300 underline"
                  href={pending.authUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open ChatGPT sign-in page
                </a>
              )}
              <p className="text-xs text-zinc-400">
                The sign-in page returns to a callback on the machine running
                Codex. On a remote or headless machine, cancel and choose Sign
                in with Device Code.
              </p>
            </>
          )}
          <p role="status" className="text-xs text-zinc-400">
            Waiting for sign-in to complete…
          </p>
          <button
            type="button"
            disabled={busy}
            className={button}
            onClick={() =>
              void act(async () => {
                setData(await cancelCodexLogin(pending.id));
              })
            }
          >
            Cancel sign-in
          </button>
        </section>
      )}

      {data && !pending && (
        <section className="space-y-2">
          <h3 className="font-semibold">
            {signedIn ? "Switch account" : "Choose how you want to use Codex"}
          </h3>
          <MethodButton
            title="Sign in with Device Code"
            description={
              data.methods.deviceCode
                ? "Sign in from another device with a one-time code"
                : "ChatGPT login is disabled"
            }
            disabled={busy || !data.methods.deviceCode}
            onClick={() =>
              void act(async () => {
                setData(await startCodexLogin({ type: "chatgptDeviceCode" }));
              })
            }
          />
          <MethodButton
            title="Sign in with ChatGPT"
            description={
              data.methods.chatgpt
                ? "Usage included with Plus, Pro, Business, and Enterprise plans · browser callback must reach the Codex machine"
                : "ChatGPT login is disabled"
            }
            disabled={busy || !data.methods.chatgpt}
            onClick={() =>
              void act(async () => {
                setData(await startCodexLogin({ type: "chatgpt" }));
              })
            }
          />
          {data.methods.apiKey ? (
            <MethodButton
              title="Provide your own API key"
              description="Pay for what you use"
              disabled={busy}
              onClick={() => setPanel(panel === "apiKey" ? null : "apiKey")}
            />
          ) : (
            <p className="text-xs text-zinc-400">
              API key login is disabled by this workspace. Sign in with ChatGPT
              to continue.
            </p>
          )}
          {panel === "apiKey" && (
            <form
              className="space-y-2 rounded-lg border border-zinc-700 p-3"
              autoComplete="off"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                void act(async () => {
                  const key = apiKey;
                  setApiKey("");
                  setData(
                    await startCodexLogin({ type: "apiKey", apiKey: key }),
                  );
                  setPanel(null);
                });
              }}
            >
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">
                  Use your own OpenAI API key for usage-based billing
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={apiKey}
                  placeholder="Paste or type your API key"
                  onChange={(event) => setApiKey(event.target.value)}
                  className={field}
                />
              </label>
              <button
                type="submit"
                disabled={busy || !apiKey.trim()}
                className={primary}
              >
                Save API key
              </button>
            </form>
          )}
          {data.methods.bedrock && (
            <MethodButton
              title="Use Amazon Bedrock"
              description="Connect using your AWS credentials"
              disabled={busy}
              onClick={() => {
                setPanel(panel === "bedrock" ? null : "bedrock");
                if (!discovery)
                  void act(async () =>
                    setDiscovery(await discoverCodexBedrock()),
                  );
              }}
            />
          )}
          {panel === "bedrock" && (
            <div className="space-y-3 rounded-lg border border-zinc-700 p-3">
              <p className="font-semibold">Set up Amazon Bedrock</p>
              <p className="text-xs text-zinc-400">
                Bedrock setup changes the configured model provider for new
                conversations.{" "}
                <a
                  href={BEDROCK_GUIDE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-cyan-300 underline"
                >
                  Learn more
                </a>
              </p>
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">AWS region</span>
                <input
                  value={region}
                  placeholder="us-east-1"
                  spellCheck={false}
                  onChange={(event) => setRegion(event.target.value)}
                  className={field}
                />
              </label>
              {!discovery && busy && (
                <p role="status" className="text-xs text-zinc-400">
                  Checking for existing AWS credentials…
                </p>
              )}
              {discovery?.profiles.map((profile) => (
                <button
                  key={profile.name}
                  type="button"
                  disabled={busy || !(profile.region || regionValue)}
                  className={`${button} w-full`}
                  onClick={() =>
                    void bedrock({
                      type: "profile",
                      profile: profile.name,
                      region: regionValue || profile.region,
                    })
                  }
                >
                  Continue with {profile.name}
                  {profile.region ? ` (${profile.region})` : ""}
                </button>
              ))}
              {discovery && discovery.environmentCredentials.length > 0 && (
                <button
                  type="button"
                  disabled={
                    busy ||
                    !(
                      regionValue ||
                      discovery.environmentCredentials.some((c) => c.region)
                    )
                  }
                  className={`${button} w-full`}
                  onClick={() =>
                    void bedrock({
                      type: "environment",
                      region:
                        regionValue ||
                        discovery.environmentCredentials.find((c) => c.region)
                          ?.region,
                    })
                  }
                >
                  Use your existing AWS credentials
                </button>
              )}
              {discovery &&
                !discovery.profiles.length &&
                !discovery.environmentCredentials.length && (
                  <p className="text-xs text-zinc-400">
                    No AWS profiles or environment credentials were detected.
                  </p>
                )}
              <details className="rounded border border-zinc-700/60 p-2">
                <summary className="cursor-pointer">AWS access keys</summary>
                <form
                  className="mt-2 space-y-2"
                  autoComplete="off"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void bedrock({
                      type: "amazonBedrockAccessKeys",
                      accessKeyId,
                      secretAccessKey,
                      sessionToken: sessionToken || null,
                      region: regionValue,
                    });
                  }}
                >
                  <input
                    aria-label="AWS access key ID"
                    placeholder="AWS access key ID"
                    autoComplete="off"
                    spellCheck={false}
                    value={accessKeyId}
                    onChange={(event) => setAccessKeyId(event.target.value)}
                    className={field}
                  />
                  <input
                    type="password"
                    aria-label="AWS secret access key"
                    placeholder="AWS secret access key"
                    autoComplete="off"
                    value={secretAccessKey}
                    onChange={(event) => setSecretAccessKey(event.target.value)}
                    className={field}
                  />
                  <input
                    type="password"
                    aria-label="AWS session token (optional)"
                    placeholder="AWS session token (optional)"
                    autoComplete="off"
                    value={sessionToken}
                    onChange={(event) => setSessionToken(event.target.value)}
                    className={field}
                  />
                  <button
                    type="submit"
                    disabled={
                      busy ||
                      !accessKeyId.trim() ||
                      !secretAccessKey.trim() ||
                      !regionValue
                    }
                    className={primary}
                  >
                    Use access keys
                  </button>
                </form>
              </details>
              <details className="rounded border border-zinc-700/60 p-2">
                <summary className="cursor-pointer">Bedrock API key</summary>
                <form
                  className="mt-2 space-y-2"
                  autoComplete="off"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void bedrock({
                      type: "amazonBedrock",
                      apiKey: bedrockKey,
                      region: regionValue,
                    });
                  }}
                >
                  <input
                    type="password"
                    aria-label="Bedrock API key"
                    placeholder="Enter a Bedrock API key"
                    autoComplete="off"
                    value={bedrockKey}
                    onChange={(event) => setBedrockKey(event.target.value)}
                    className={field}
                  />
                  <button
                    type="submit"
                    disabled={busy || !bedrockKey.trim() || !regionValue}
                    className={primary}
                  >
                    Use Bedrock API key
                  </button>
                </form>
              </details>
            </div>
          )}
        </section>
      )}

      {gateway?.required && (
        <section className="space-y-2 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3">
          <p className="font-semibold">
            Gateway sign-in · {gateway.providerName || gateway.providerId}
          </p>
          <p className="text-xs text-zinc-400">
            Status:{" "}
            {gateway.loginInFlight ? "started" : (gateway.status ?? "unknown")}
          </p>
          {gateway.error && (
            <p className="break-words text-xs text-red-400">{gateway.error}</p>
          )}
          {gateway.authUrl && (
            <>
              <a
                className="break-all text-cyan-300 underline"
                href={gateway.authUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open gateway authorization page
              </a>
              <p className="text-xs text-zinc-400">
                Complete authorization using a browser that can reach the
                callback address on the machine running Codex.
              </p>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            {gateway.loginInFlight ? (
              <button
                type="button"
                disabled={busy}
                className={button}
                onClick={() =>
                  void act(async () => setData(await cancelCodexGatewayLogin()))
                }
              >
                Cancel gateway sign-in
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                className={primary}
                onClick={() =>
                  void act(async () => setData(await startCodexGatewayLogin()))
                }
              >
                {gateway.status === "succeeded"
                  ? "Sign in to gateway again"
                  : "Sign in to gateway"}
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
