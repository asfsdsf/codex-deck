import { useCallback, useState, type FormEvent, type ReactNode } from "react";
import type { CodexProject, CodexThreadSection } from "@codex-deck/api";
import {
  assignCodexThreadProject,
  createCodexProject,
  createCodexThreadSection,
  deleteCodexProject,
  deleteCodexThreadSection,
  getCodexProjects,
  moveCodexProject,
  moveCodexThreadSection,
  renameCodexThreadSection,
  updateCodexProject,
} from "../codex-organization-api";
import {
  getProjectMoveTarget,
  getThreadsInDirectory,
  newIdempotencyKey,
  parseRootList,
} from "../codex-projects-view";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";

const inputClass =
  "mt-1 w-full min-w-0 rounded border border-zinc-700 bg-zinc-950 p-2 text-zinc-100";
const buttonClass =
  "rounded border border-zinc-700 px-3 py-2 disabled:opacity-50";
const dangerClass =
  "rounded bg-red-600 px-3 py-2 text-white disabled:opacity-50";
const primaryClass =
  "rounded bg-cyan-600 px-3 py-2 text-white disabled:opacity-50";

const errorText = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

function RenameRow({
  label,
  name,
  detail,
  busy,
  onRename,
  onDelete,
  deleteWarning,
  extra,
}: {
  label: string;
  name: string;
  detail?: string;
  busy: boolean;
  onRename: (name: string) => void;
  onDelete: () => void;
  deleteWarning: string;
  extra?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div className="space-y-2 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3">
      {editing ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.trim()) return;
            onRename(draft.trim());
            setEditing(false);
          }}
        >
          <label className="block min-w-0 flex-1 text-xs text-zinc-400">
            {label} name
            <input
              className={inputClass}
              value={draft}
              maxLength={200}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            className={primaryClass}
          >
            Save
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setEditing(false)}
            className={buttonClass}
          >
            Cancel
          </button>
        </form>
      ) : (
        <div className="min-w-0">
          <p className="break-words font-semibold">{name}</p>
          {detail && (
            <p className="break-all text-xs text-zinc-400">{detail}</p>
          )}
        </div>
      )}
      {confirmDelete ? (
        <div className="space-y-2">
          <p>{deleteWarning}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                onDelete();
                setConfirmDelete(false);
              }}
              className={dangerClass}
            >
              Confirm delete
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmDelete(false)}
              className={buttonClass}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        !editing && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(name);
                setEditing(true);
              }}
              className={buttonClass}
            >
              Rename
            </button>
            {extra}
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
              className={buttonClass}
            >
              Delete
            </button>
          </div>
        )
      )}
    </div>
  );
}

export default function CodexProjects({
  threadId,
}: {
  threadId: string | null;
}) {
  const load = useCallback(() => getCodexProjects(), []);
  const { data, loading, error, refresh } = useNativeSnapshot(
    "projects",
    null,
    load,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const current = threadId ? (data?.threads[threadId] ?? null) : null;
  const [projectName, setProjectName] = useState("");
  const [rootsText, setRootsText] = useState<string | null>(null);
  const [includeThreads, setIncludeThreads] = useState(false);
  const [createKey, setCreateKey] = useState(newIdempotencyKey);
  const [sectionName, setSectionName] = useState("");

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

  const roots = parseRootList(rootsText ?? current?.cwd ?? "");
  const importable =
    data && roots.length === 1 ? getThreadsInDirectory(data, roots[0]) : [];
  // A changed form is a new request; retries of the same form reuse the key.
  const editCreateForm = () => setCreateKey(newIdempotencyKey());

  const create = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      const { project } = await createCodexProject({
        name: projectName.trim(),
        roots,
        idempotencyKey: createKey,
        ...(includeThreads && importable.length
          ? { threadIds: importable }
          : {}),
      });
      setProjectName("");
      setRootsText(null);
      setIncludeThreads(false);
      setCreateKey(newIdempotencyKey());
      return `Created ${project.name}.`;
    });
  };

  const projects: CodexProject[] = data?.projects ?? [];
  const sections: CodexThreadSection[] | null = data?.sections ?? null;

  return (
    <div className="space-y-3 text-sm">
      <p className="text-zinc-400">
        Named projects and sections are stored by Codex and shared with other
        Codex clients. They add labels and ordering alongside Deck&apos;s
        directory grouping, which is unchanged.
      </p>
      <div className="flex justify-end">
        <button
          type="button"
          disabled={loading || busy}
          onClick={refresh}
          className={buttonClass}
        >
          Refresh
        </button>
      </div>
      {loading && !data && <p role="status">Loading projects…</p>}
      {error && (
        <p role="alert" className="break-words text-red-400">
          {error}
        </p>
      )}
      {data && !data.available && (
        <p className="break-words text-zinc-400">
          Named projects are not available on this Codex server
          {data.unavailableReason ? ` (${data.unavailableReason})` : ""}.
        </p>
      )}
      {data?.available && threadId && (
        <section className="space-y-2 rounded-lg border border-zinc-700 p-3">
          <h3 className="font-semibold">This conversation</h3>
          {!current && (
            <p className="text-xs text-zinc-400">
              Not among recent Codex threads; changes still apply if Codex knows
              this conversation.
            </p>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-xs text-zinc-400">
              Project
              <select
                className={inputClass}
                disabled={busy}
                value={current?.projectId ?? ""}
                onChange={(event) =>
                  void act(async () => {
                    await assignCodexThreadProject(
                      threadId,
                      event.target.value || null,
                    );
                    return event.target.value
                      ? "Moved conversation to project."
                      : "Removed conversation from its project.";
                  })
                }
              >
                <option value="">No project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            {sections && (
              <label className="block text-xs text-zinc-400">
                Section
                <select
                  className={inputClass}
                  disabled={busy}
                  value={current?.sectionId ?? ""}
                  onChange={(event) =>
                    void act(async () => {
                      await moveCodexThreadSection(
                        threadId,
                        event.target.value || null,
                      );
                      return event.target.value
                        ? "Moved conversation to section."
                        : "Removed conversation from its section.";
                    })
                  }
                >
                  <option value="">No section</option>
                  {sections.map((section) => (
                    <option key={section.id} value={section.id}>
                      {section.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </section>
      )}
      {data?.available && (
        <section className="space-y-2">
          <h3 className="font-semibold">Projects</h3>
          {!projects.length && (
            <p className="text-zinc-400">No named projects yet.</p>
          )}
          {projects.map((project, index) => (
            <RenameRow
              key={`${project.id}:${project.name}`}
              label="Project"
              name={project.name}
              detail={project.roots.join(", ")}
              busy={busy}
              deleteWarning={`Delete ${project.name}? Its conversations stay but lose this project assignment.`}
              onRename={(name) =>
                void act(async () => {
                  await updateCodexProject(project.id, { name });
                  return "Project renamed.";
                })
              }
              onDelete={() =>
                void act(async () => {
                  await deleteCodexProject(project.id);
                  return `Deleted ${project.name}.`;
                })
              }
              extra={([-1, 1] as const).map((direction) => {
                const target = getProjectMoveTarget(projects, index, direction);
                return (
                  <button
                    key={direction}
                    type="button"
                    disabled={busy || target === undefined}
                    aria-label={`Move ${project.name} ${direction < 0 ? "up" : "down"}`}
                    onClick={() =>
                      void act(async () => {
                        await moveCodexProject(project.id, target ?? null);
                        return "Project order updated.";
                      })
                    }
                    className={buttonClass}
                  >
                    {direction < 0 ? "Up" : "Down"}
                  </button>
                );
              })}
            />
          ))}
          <form
            onSubmit={create}
            className="space-y-2 rounded-lg border border-zinc-700 p-3"
          >
            <h4 className="font-semibold">New project</h4>
            <label className="block text-xs text-zinc-400">
              Name
              <input
                className={inputClass}
                required
                maxLength={200}
                value={projectName}
                onChange={(event) => {
                  setProjectName(event.target.value);
                  editCreateForm();
                }}
              />
            </label>
            <label className="block text-xs text-zinc-400">
              Root directories on the Codex host (one absolute path per line)
              <textarea
                className={`${inputClass} min-h-16 font-mono text-xs`}
                value={rootsText ?? current?.cwd ?? ""}
                onChange={(event) => {
                  setRootsText(event.target.value);
                  editCreateForm();
                }}
              />
            </label>
            {importable.length > 0 && (
              <label className="flex items-start gap-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={includeThreads}
                  onChange={(event) => {
                    setIncludeThreads(event.target.checked);
                    editCreateForm();
                  }}
                />
                Include {importable.length} recent conversation
                {importable.length === 1 ? "" : "s"} in this directory
              </label>
            )}
            <button
              type="submit"
              disabled={busy || !projectName.trim() || !roots.length}
              className={primaryClass}
            >
              {busy ? "Saving…" : "Create project"}
            </button>
          </form>
        </section>
      )}
      {data?.available && sections && (
        <section className="space-y-2">
          <h3 className="font-semibold">Sections</h3>
          {!sections.length && (
            <p className="text-zinc-400">No sections yet.</p>
          )}
          {sections.map((section) => (
            <RenameRow
              key={`${section.id}:${section.name}`}
              label="Section"
              name={section.name}
              busy={busy}
              deleteWarning={`Delete ${section.name}? Its conversations are kept and become unsectioned.`}
              onRename={(name) =>
                void act(async () => {
                  await renameCodexThreadSection(section.id, name);
                  return "Section renamed.";
                })
              }
              onDelete={() =>
                void act(async () => {
                  await deleteCodexThreadSection(section.id);
                  return `Deleted ${section.name}.`;
                })
              }
            />
          ))}
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                const { section } = await createCodexThreadSection(
                  sectionName.trim(),
                );
                setSectionName("");
                return `Created ${section.name}.`;
              });
            }}
          >
            <label className="block min-w-0 flex-1 text-xs text-zinc-400">
              New section
              <input
                className={inputClass}
                maxLength={200}
                value={sectionName}
                onChange={(event) => setSectionName(event.target.value)}
              />
            </label>
            <button
              type="submit"
              disabled={busy || !sectionName.trim()}
              className={primaryClass}
            >
              Create section
            </button>
          </form>
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
