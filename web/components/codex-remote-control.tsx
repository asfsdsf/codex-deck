import { useCallback, useEffect, useState } from "react";
import type {
  RemoteControlClientInfo,
  RemoteControlConnectionStatus,
  RemoteControlPairing,
} from "@codex-deck/api";
import {
  getCodexRemoteControl,
  getCodexRemoteControlPairingStatus,
  revokeCodexRemoteControlClient,
  setCodexRemoteControlEnabled,
  startCodexRemoteControlPairing,
} from "../codex-organization-api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";

const PAIRING_POLL_MS = 2_000;

const STATUS_LABEL: Record<RemoteControlConnectionStatus, string> = {
  disabled: "Disabled",
  connecting: "Connecting",
  connected: "Connected",
  errored: "Error",
};
const STATUS_CLASS: Record<RemoteControlConnectionStatus, string> = {
  disabled: "border-zinc-700 text-zinc-400",
  connecting: "border-amber-500/40 text-amber-300",
  connected: "border-emerald-500/40 text-emerald-300",
  errored: "border-red-500/40 text-red-300",
};

const errorText = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

function formatSeconds(seconds: number | null): string {
  if (seconds === null) return "Never";
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

export function describeRemoteClient(client: RemoteControlClientInfo): string {
  return (
    [client.deviceModel, client.platform, client.osVersion]
      .filter(Boolean)
      .join(" · ") ||
    client.deviceType ||
    "Unknown device"
  );
}

export default function CodexRemoteControl() {
  const load = useCallback(() => getCodexRemoteControl(), []);
  const { data, loading, error, refresh } = useNativeSnapshot(
    "remoteControl",
    null,
    load,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [ephemeral, setEphemeral] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [pairing, setPairing] = useState<RemoteControlPairing | null>(null);
  const [claimed, setClaimed] = useState(false);
  const [now, setNow] = useState(() => Date.now() / 1000);

  const status = data?.status ?? null;
  const expired = !!pairing && pairing.expiresAt <= now;

  useEffect(() => {
    if (!pairing || claimed) return;
    const id = window.setInterval(() => setNow(Date.now() / 1000), 1_000);
    return () => window.clearInterval(id);
  }, [pairing, claimed]);

  useEffect(() => {
    if (!pairing || claimed || expired) return;
    let active = true;
    const poll = () => {
      if (document.hidden) return;
      void getCodexRemoteControlPairingStatus(pairing).then(
        (result) => {
          if (!active || !result.claimed) return;
          setClaimed(true);
          setMessage("Device paired.");
          refresh();
        },
        () => undefined,
      );
    };
    const id = window.setInterval(poll, PAIRING_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [pairing, claimed, expired, refresh]);

  const act = async (work: () => Promise<string>) => {
    setBusy(true);
    setMessage("");
    try {
      setMessage(await work());
      refresh();
    } catch (reason) {
      setMessage(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (enabled: boolean) =>
    act(async () => {
      const result = await setCodexRemoteControlEnabled(enabled, ephemeral);
      setConfirmDisable(false);
      if (!enabled) setPairing(null);
      return `Remote control ${STATUS_LABEL[result.status.status].toLowerCase()}.`;
    });

  const pair = () =>
    act(async () => {
      setClaimed(false);
      setNow(Date.now() / 1000);
      setPairing(await startCodexRemoteControlPairing());
      return "";
    });

  const revoke = (environmentId: string, clientId: string) =>
    act(async () => {
      await revokeCodexRemoteControlClient(environmentId, clientId);
      setConfirmRevoke(null);
      return "Device access revoked.";
    });

  const secondsLeft = pairing
    ? Math.max(0, Math.ceil(pairing.expiresAt - now))
    : 0;

  return (
    <div className="space-y-3 text-sm">
      <p className="text-zinc-400">
        Codex remote control lets paired devices connect to this Codex
        app-server through Codex&apos;s own relay. It is separate from Codex
        Deck remote access, which uses Deck&apos;s server login.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {status ? (
          <span
            className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_CLASS[status.status]}`}
            role="status"
          >
            {STATUS_LABEL[status.status]}
          </span>
        ) : (
          <span />
        )}
        <button
          type="button"
          disabled={loading || busy}
          onClick={refresh}
          className="rounded border border-zinc-700 px-3 py-2 disabled:opacity-50"
        >
          Refresh
        </button>
      </div>
      {loading && !data && <p role="status">Loading remote control…</p>}
      {error && (
        <p role="alert" className="break-words text-red-400">
          {error}
        </p>
      )}
      {data && !data.available && (
        <p className="break-words text-zinc-400">
          Codex remote control is not available on this Codex server
          {data.unavailableReason ? ` (${data.unavailableReason})` : ""}.
        </p>
      )}
      {status && (
        <section className="space-y-3 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3">
          <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
            <dt className="text-zinc-500">Server name</dt>
            <dd className="break-all text-zinc-200">{status.serverName}</dd>
            <dt className="text-zinc-500">Environment</dt>
            <dd className="break-all text-zinc-200">
              {status.environmentId ?? "Not enrolled"}
            </dd>
            <dt className="text-zinc-500">Installation</dt>
            <dd className="break-all text-zinc-400">{status.installationId}</dd>
          </dl>
          <label className="flex items-start gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={ephemeral}
              disabled={busy}
              onChange={(event) => setEphemeral(event.target.checked)}
            />
            Apply only until the Codex app-server restarts (do not save to
            config)
          </label>
          {status.status === "disabled" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void toggle(true)}
              className="rounded bg-cyan-600 px-3 py-2 text-white disabled:opacity-50"
            >
              {busy ? "Enabling…" : "Enable remote control"}
            </button>
          ) : confirmDisable ? (
            <div className="space-y-2">
              <p>
                Disable remote control? Paired devices disconnect until it is
                enabled again.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void toggle(false)}
                  className="rounded bg-red-600 px-3 py-2 text-white disabled:opacity-50"
                >
                  {busy ? "Disabling…" : "Confirm disable"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmDisable(false)}
                  className="rounded border border-zinc-700 px-3 py-2"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmDisable(true)}
              className="rounded border border-zinc-700 px-3 py-2 disabled:opacity-50"
            >
              Disable remote control
            </button>
          )}
        </section>
      )}
      {status && status.status !== "disabled" && (
        <section className="space-y-2 rounded-lg border border-zinc-700 p-3">
          <h3 className="font-semibold">Pair a device</h3>
          {pairing && !claimed && !expired ? (
            <div className="space-y-2">
              <p className="text-zinc-400">
                Enter this code on the device you want to pair. Waiting for the
                device to claim it…
              </p>
              <p
                className="break-all font-mono text-2xl font-semibold tracking-widest text-zinc-100"
                aria-label="Pairing code"
              >
                {pairing.manualPairingCode ?? pairing.pairingCode}
              </p>
              <p className="text-xs text-zinc-500" aria-live="polite">
                Expires in {Math.floor(secondsLeft / 60)}:
                {String(secondsLeft % 60).padStart(2, "0")}
              </p>
            </div>
          ) : pairing && expired && !claimed ? (
            <p className="text-amber-300">This pairing code expired.</p>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void pair()}
            className="rounded border border-zinc-700 px-3 py-2 disabled:opacity-50"
          >
            {pairing && !claimed && !expired
              ? "Generate a new code"
              : "Start pairing"}
          </button>
        </section>
      )}
      {status?.environmentId && (
        <section className="space-y-2">
          <h3 className="font-semibold">Paired devices</h3>
          {data?.clientsError && (
            <p role="alert" className="break-words text-red-400">
              {data.clientsError}
            </p>
          )}
          {!data?.clientsError && !data?.clients.length && (
            <p className="text-zinc-400">No devices are paired.</p>
          )}
          {data?.clients.map((client) => (
            <div
              key={client.clientId}
              className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3"
            >
              <div className="min-w-0">
                <p className="break-words font-semibold">
                  {client.displayName || describeRemoteClient(client)}
                </p>
                <p className="break-words text-xs text-zinc-400">
                  {describeRemoteClient(client)}
                  {client.appVersion ? ` · App ${client.appVersion}` : ""}
                </p>
                <p className="text-xs text-zinc-500">
                  Last seen {formatSeconds(client.lastSeenAt)}
                </p>
              </div>
              {confirmRevoke === client.clientId ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void revoke(status.environmentId!, client.clientId)
                    }
                    className="rounded bg-red-600 px-3 py-2 text-white disabled:opacity-50"
                  >
                    {busy ? "Revoking…" : "Confirm revoke"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmRevoke(null)}
                    className="rounded border border-zinc-700 px-3 py-2"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmRevoke(client.clientId)}
                  className="rounded border border-zinc-700 px-3 py-2 disabled:opacity-50"
                >
                  Revoke
                </button>
              )}
            </div>
          ))}
        </section>
      )}
      {message && (
        <p role="status" className="break-words text-amber-300">
          {message}
        </p>
      )}
    </div>
  );
}
