import { useEffect, useId, useState, type FormEvent } from "react";
import { Network, Pencil, Save, Trash2 } from "lucide-react";
import type {
  CodexHomeDescriptor,
  LlmProviderSettings as ProviderDetails,
} from "@codex-deck/api";
import { requestJson } from "../transport";
import { REASONING_EFFORTS } from "../reasoning-efforts";
import {
  EmptySettingsList,
  Field,
  INPUT_CLASS,
  REMOVE_BUTTON,
  SETTINGS_CARD,
} from "./settings-fields";

const PROVIDERS = "/api/codex-homes/providers";
const BUTTON =
  "h-8 rounded border border-zinc-700 bg-zinc-900 px-3 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50";

function providerPath(id: string) {
  return PROVIDERS + "/" + encodeURIComponent(id.slice("llm:".length));
}

function ProviderForm({
  path,
  existing,
  onSaved,
  onClose,
}: {
  path: string;
  existing?: ProviderDetails;
  onSaved: (p: CodexHomeDescriptor) => void;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const effortListId = useId();
  const [error, setError] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [url, setUrl] = useState(existing?.url ?? "");
  const sameOrigin =
    existing &&
    URL.canParse(url) &&
    new URL(url).origin === new URL(existing.url).origin;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const key = String(data.get("apiKey") ?? "");
    setSaving(true);
    setError("");
    try {
      const provider = await requestJson<CodexHomeDescriptor>(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: data.get("label"),
          model: data.get("model"),
          reasoningEffort: String(data.get("reasoningEffort") ?? "").trim(),
          url,
          revision: existing?.revision,
          apiKey: clearKey ? "" : key || undefined,
        }),
      });
      onSaved(provider);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form onSubmit={save} className="space-y-3">
      <fieldset disabled={saving} className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Field label="Provider name">
          <input
            autoFocus
            required
            name="label"
            defaultValue={existing?.label}
            placeholder="Local model"
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="Model ID">
          <input
            required
            name="model"
            defaultValue={existing?.model}
            placeholder="Model name"
            autoCapitalize="none"
            spellCheck={false}
            className={`${INPUT_CLASS} font-mono text-xs`}
          />
        </Field>
        <Field label="Default reasoning effort">
          <input
            name="reasoningEffort"
            list={effortListId}
            defaultValue={existing?.reasoningEffort}
            placeholder="Model default"
            autoCapitalize="none"
            spellCheck={false}
            className={INPUT_CLASS}
          />
          <datalist id={effortListId}>
            {REASONING_EFFORTS.map((effort) => (
              <option key={effort} value={effort} />
            ))}
          </datalist>
        </Field>
        <div className="sm:col-span-2">
          <Field label="OpenAI-compatible API URL">
            <input
              required
              name="url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:8000/v1"
              autoCapitalize="none"
              spellCheck={false}
              className={`${INPUT_CLASS} font-mono text-xs`}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="API key (optional)">
            <input
              name="apiKey"
              type="password"
              disabled={clearKey}
              autoComplete="new-password"
              placeholder={
                existing?.hasApiKey && !clearKey
                  ? sameOrigin
                    ? "Keep saved key"
                    : "Enter a key for the new endpoint"
                  : ""
              }
              className={INPUT_CLASS}
            />
          </Field>
          {existing?.hasApiKey && (
            <label className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={clearKey}
                onChange={(e) => setClearKey(e.target.checked)}
              />
              Clear saved API key
            </label>
          )}
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className={`${BUTTON} inline-flex items-center gap-1.5`}
        >
          <Save size={14} />
          {saving ? "Saving..." : "Save provider"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={onClose}
          className={BUTTON}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

interface ProviderActions {
  onSaved: (provider: CodexHomeDescriptor) => void;
  onRemoved: (id: string) => void;
}

function SavedProvider({
  provider,
  onSaved,
  onRemoved,
}: ProviderActions & { provider: CodexHomeDescriptor }) {
  const [mode, setMode] = useState<"view" | "edit" | "remove">("view");
  const [details, setDetails] = useState<ProviderDetails | null>(null);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);
  const path = providerPath(provider.id);
  useEffect(() => {
    if (mode !== "edit") return;
    let active = true;
    void requestJson<ProviderDetails>(path).then(
      (value) => {
        if (active) setDetails(value);
      },
      (e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      active = false;
    };
  }, [mode, path]);
  function changeMode(next: typeof mode) {
    setError("");
    setDetails(null);
    setMode(next);
  }
  async function remove() {
    setRemoving(true);
    setError("");
    try {
      await requestJson(
        path +
          "?revision=" +
          encodeURIComponent(provider.providerRevision ?? "initial"),
        { method: "DELETE" },
      );
      onRemoved(provider.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoving(false);
    }
  }
  return (
    <div className={`${SETTINGS_CARD} border-zinc-800`}>
      {mode === "edit" && details ? (
        <ProviderForm
          path={path}
          existing={details}
          onSaved={onSaved}
          onClose={() => changeMode("view")}
        />
      ) : (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="break-words text-sm font-medium text-zinc-100">
              {provider.label}
            </div>
            <div className="break-all font-mono text-xs text-zinc-400">
              {provider.model}
            </div>
          </div>
          {mode === "view" ? (
            <>
              <button
                type="button"
                aria-label={`Edit ${provider.label}`}
                title="Edit provider"
                onClick={() => changeMode("edit")}
                className="h-9 w-8 shrink-0 rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"
              >
                <Pencil className="mx-auto h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label={`Remove ${provider.label}`}
                title="Remove provider"
                onClick={() => changeMode("remove")}
                className={REMOVE_BUTTON}
              >
                <Trash2 className="mx-auto h-4 w-4" />
              </button>
            </>
          ) : (
            mode === "edit" && (
              <button
                type="button"
                className={BUTTON}
                onClick={() => changeMode("view")}
              >
                Cancel
              </button>
            )
          )}
        </div>
      )}
      {mode === "remove" && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-zinc-300">
            Remove this provider? Conversation files will stay on disk.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={removing}
              onClick={() => void remove()}
              className={`${BUTTON} text-red-300`}
            >
              Remove provider
            </button>
            <button
              type="button"
              disabled={removing}
              className={BUTTON}
              onClick={() => changeMode("view")}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

export function LlmProviderSettings({
  providers,
  adding,
  onSaved,
  onRemoved,
  onClose,
}: ProviderActions & {
  providers: CodexHomeDescriptor[];
  adding: boolean;
  onClose: () => void;
}) {
  const list = providers.filter((p) => p.kind === "llm");
  return (
    <div className="space-y-3 py-5">
      {!list.length && !adding && (
        <EmptySettingsList icon={Network}>No chat providers</EmptySettingsList>
      )}
      {list.map((provider) => (
        <SavedProvider
          key={provider.id}
          provider={provider}
          onSaved={onSaved}
          onRemoved={onRemoved}
        />
      ))}
      {adding && (
        <div className={`${SETTINGS_CARD} border-zinc-800`}>
          <ProviderForm path={PROVIDERS} onSaved={onSaved} onClose={onClose} />
        </div>
      )}
    </div>
  );
}
