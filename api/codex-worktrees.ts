import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { isPathWithinDirectory } from "./path-utils";
import { CodexWorkspaceError } from "./codex-working-directory";
import type { CodexThreadSummary } from "./storage/runtime";

/**
 * Codex-compatible managed worktrees (upstream `codex-worktree` crate): detached
 * checkouts under `<root>/<4 hex>/<repository>` with a `codex-thread.json`
 * owner record in each worktree's Git directory. Git runs on the Deck backend
 * host. Workflow task worktrees (`.codex-deck/worktrees`) are unaffected.
 */
export interface CodexManagedWorktree {
  root: string;
  cwd: string;
  sourceRoot: string;
  sourceCwd: string;
  headSha: string;
  branch: string | null;
}

export interface CodexWorktreeEntry extends CodexManagedWorktree {
  ownerThreadId: string | null;
  owner: {
    status: "none" | "unavailable" | "resumable";
    title: string | null;
    updatedAt: number | null;
  };
  isCurrent: boolean;
}

export interface CodexWorktreeList {
  root: string;
  sourceCwd: string;
  entries: CodexWorktreeEntry[];
}

export type CodexWorktreeMode = "fork" | "new";

export interface CodexWorktreeStartResult {
  mode: CodexWorktreeMode;
  checkout: CodexManagedWorktree;
  thread: CodexThreadSummary;
  previousThreadId: string;
  warning: string | null;
}

const OWNER_FILENAME = "codex-thread.json";
const DISABLED_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null";
const INHERITED_GIT_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of INHERITED_GIT_ENV) delete env[name];
  env.GIT_LFS_SKIP_SMUDGE = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

async function runGit(
  cwd: string,
  args: string[],
  options: { allowStatus1?: boolean } = {},
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      [
        "-c",
        "safe.bareRepository=explicit",
        "-c",
        `core.hooksPath=${DISABLED_HOOKS_PATH}`,
        "-c",
        "core.fsmonitor=",
        "-c",
        "attr.tree=",
        "-c",
        "core.attributesFile=",
        ...args,
      ],
      {
        cwd,
        env: gitEnv(),
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) return resolvePromise(stdout);
        if (options.allowStatus1 && (error as { code?: unknown }).code === 1)
          return resolvePromise(Buffer.alloc(0));
        const detail = stderr?.toString().trim() || error.message;
        reject(new Error(`git command failed: ${detail}`));
      },
    );
  });
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  return (await runGit(cwd, args)).toString("utf8").trim();
}

/** Working-tree operations disable configured clean/smudge/process filters. */
async function filterOverrides(cwd: string): Promise<string[]> {
  const output = await runGit(
    cwd,
    ["config", "--null", "--name-only", "--get-regexp", "^filter\\."],
    { allowStatus1: true },
  );
  const drivers = new Set<string>();
  for (const name of output.toString("utf8").split("\0")) {
    const match = /^filter\.(.+)\.(clean|smudge|process|required)$/.exec(name);
    if (match?.[1]) drivers.add(match[1]);
  }
  return [...drivers].flatMap((driver) => [
    "-c",
    `filter.${driver}.process=`,
    "-c",
    `filter.${driver}.clean=`,
    "-c",
    `filter.${driver}.smudge=`,
    "-c",
    `filter.${driver}.required=false`,
  ]);
}

async function workingTreeGit(cwd: string, args: string[]): Promise<Buffer> {
  return runGit(cwd, [...(await filterOverrides(cwd)), ...args]);
}

async function repositoryRoot(cwd: string): Promise<string> {
  try {
    return await realpath(await gitText(cwd, ["rev-parse", "--show-toplevel"]));
  } catch {
    throw new CodexWorkspaceError(
      "Managed worktrees require a local Git repository.",
    );
  }
}

async function resolveGitPath(checkout: string, arg: string): Promise<string> {
  return realpath(
    resolve(checkout, await gitText(checkout, ["rev-parse", arg])),
  );
}

function hasManagedLayout(root: string, checkout: string): boolean {
  const rel = relative(root, checkout);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
  const parts = rel.split(sep);
  return parts.length === 2 && /^[0-9a-f]{4}$/i.test(parts[0]) && !!parts[1];
}

async function isSafeCwd(root: string, cwd: string): Promise<boolean> {
  try {
    const [resolvedRoot, resolvedCwd] = await Promise.all([
      realpath(root),
      realpath(cwd),
    ]);
    return (
      (await stat(resolvedCwd)).isDirectory() &&
      isPathWithinDirectory(resolvedCwd, resolvedRoot)
    );
  } catch {
    return false;
  }
}

async function removeEmptyBucket(checkout: string) {
  await rmdir(dirname(checkout)).catch(() => undefined);
}

/** Resolves `desktop.git-worktree-root` (absolute) or `<codex home>/worktrees`. */
export function resolveWorktreeRoot(
  codexHome: string,
  desktop: Record<string, unknown> | null | undefined,
): string {
  const configured = desktop?.["git-worktree-root"];
  if (configured == null) return join(codexHome, "worktrees");
  if (typeof configured !== "string")
    throw new Error("desktop.git-worktree-root must be a string");
  const trimmed = configured.trim();
  if (!trimmed) return join(codexHome, "worktrees");
  if (!isAbsolute(trimmed))
    throw new Error("desktop.git-worktree-root must be an absolute path");
  return resolve(trimmed);
}

export class WorktreeManager {
  public constructor(public readonly root: string) {}

  public async create(sourceCwdInput: string): Promise<CodexManagedWorktree> {
    if (!isAbsolute(this.root))
      throw new Error("managed worktree root must be an absolute path");
    const sourceCwd = await realpath(sourceCwdInput).catch(() => {
      throw new CodexWorkspaceError(`cannot resolve ${sourceCwdInput}`);
    });
    const sourceRoot = await repositoryRoot(sourceCwd);
    const relativeCwd = relative(sourceRoot, sourceCwd);
    if (relativeCwd.startsWith("..") || isAbsolute(relativeCwd))
      throw new Error("working directory is outside the repository root");
    let headSha: string;
    try {
      headSha = await gitText(sourceRoot, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        "HEAD^{commit}",
      ]);
    } catch {
      throw new CodexWorkspaceError(
        "Cannot create a worktree from a repository without commits.",
      );
    }
    await mkdir(this.root, { recursive: true });
    if (process.platform === "darwin")
      await writeFile(join(this.root, ".metadata_never_index"), "");
    let root: string | null = null;
    for (let attempt = 0; attempt < 1024 && !root; attempt++) {
      const bucket = join(
        this.root,
        randomUUID().replaceAll("-", "").slice(0, 4),
      );
      try {
        await mkdir(bucket);
        root = join(bucket, basename(sourceRoot));
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw error;
      }
    }
    if (!root) throw new Error("all managed worktree identifiers are in use");
    try {
      await workingTreeGit(sourceRoot, [
        "worktree",
        "add",
        "--detach",
        "--no-checkout",
        root,
        headSha,
      ]);
    } catch (error) {
      await removeEmptyBucket(root);
      throw new Error(
        `cannot create managed worktree: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      // Write only the destination's config without enabling worktreeConfig
      // for the source repository, then materialize files at HEAD.
      const config = await gitText(root, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "config.worktree",
      ]);
      await runGit(root, ["config", "--file", config, "core.worktree", root]);
      await workingTreeGit(root, [
        "--work-tree=.",
        "reset",
        "--hard",
        "--no-recurse-submodules",
        headSha,
      ]);
    } catch (error) {
      await this.forceRemove(sourceRoot, root);
      throw new Error(
        `cannot populate managed worktree: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const cwd = join(root, relativeCwd);
    if (!(await isSafeCwd(root, cwd))) {
      await this.forceRemove(sourceRoot, root);
      throw new CodexWorkspaceError(
        `requested base does not contain a safe working directory ${relativeCwd}`,
      );
    }
    return { root, cwd, sourceRoot, sourceCwd, headSha, branch: null };
  }

  private async forceRemove(sourceRoot: string, root: string) {
    await runGit(sourceRoot, ["worktree", "remove", "--force", root]).catch(
      () => undefined,
    );
    await removeEmptyBucket(root);
  }

  public async list(sourceCwdInput: string): Promise<CodexManagedWorktree[]> {
    const sourceCwd = await realpath(sourceCwdInput).catch(() => {
      throw new CodexWorkspaceError(`cannot resolve ${sourceCwdInput}`);
    });
    const sourceRoot = await repositoryRoot(sourceCwd);
    const relativeCwd = relative(sourceRoot, sourceCwd);
    const managedRoot = await realpath(this.root).catch(() => this.root);
    const commonDir = await resolveGitPath(sourceRoot, "--git-common-dir");
    const output = await runGit(sourceCwd, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    const fields = output.toString("utf8").split("\0");
    const worktrees: CodexManagedWorktree[] = [];
    let current: string[] = [];
    const flush = async () => {
      const entry = current;
      current = [];
      const root = entry
        .find((field) => field.startsWith("worktree "))
        ?.slice("worktree ".length);
      if (!root) return;
      const head = entry.find((field) => field.startsWith("HEAD "))?.slice(5);
      const branch = entry
        .find((field) => field.startsWith("branch "))
        ?.slice(7)
        .replace(/^refs\/heads\//, "");
      try {
        const rootStat = await lstat(root);
        const bucketStat = await lstat(dirname(root));
        if (!rootStat.isDirectory() || !bucketStat.isDirectory()) return;
        const canonical = await realpath(root);
        if (!hasManagedLayout(managedRoot, canonical)) return;
        if (!(await lstat(join(canonical, ".git"))).isFile()) return;
        const gitDir = await resolveGitPath(canonical, "--git-dir");
        const linkedCommon = await resolveGitPath(
          canonical,
          "--git-common-dir",
        );
        if (gitDir === linkedCommon || linkedCommon !== commonDir) return;
        // A different checkout can occupy a stale registration's path.
        const backlink = (
          await readFile(join(gitDir, "gitdir"), "utf8")
        ).trim();
        if (
          (await realpath(resolve(gitDir, backlink))) !==
          (await realpath(join(canonical, ".git")))
        )
          return;
        const cwd = join(root, relativeCwd);
        if (!(await isSafeCwd(canonical, cwd)) || !head) return;
        worktrees.push({
          root,
          cwd,
          sourceRoot,
          sourceCwd,
          headSha: head,
          branch: branch ?? null,
        });
      } catch {
        // Skip registrations that no longer match the managed layout.
      }
    };
    for (const field of fields) {
      if (field === "") await flush();
      else current.push(field);
    }
    await flush();
    return worktrees.sort((a, b) => a.root.localeCompare(b.root));
  }

  private async managedCheckout(checkout: string): Promise<string> {
    const managedRoot = await realpath(this.root);
    const resolved = await realpath(checkout);
    if (!hasManagedLayout(managedRoot, resolved))
      throw new Error(`${checkout} is not a managed worktree`);
    return resolved;
  }

  private async ownerPath(checkout: string): Promise<string> {
    return resolve(
      checkout,
      await gitText(checkout, ["rev-parse", "--git-path", OWNER_FILENAME]),
    );
  }

  public async owner(checkout: string): Promise<string | null> {
    const path = await this.ownerPath(await this.managedCheckout(checkout));
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    }
    const record = JSON.parse(contents) as {
      version?: unknown;
      ownerThreadId?: unknown;
    };
    if (
      record.version !== 1 ||
      typeof record.ownerThreadId !== "string" ||
      !record.ownerThreadId
    )
      throw new Error(`invalid worktree owner at ${path}`);
    return record.ownerThreadId;
  }

  /** Publishes the owner record without replacing another owner. */
  public async bindThread(checkout: string, threadId: string): Promise<void> {
    if (!threadId) throw new Error("worktree owner thread ID cannot be empty");
    const existing = await this.owner(checkout);
    if (existing === threadId) return;
    if (existing)
      throw new Error(`worktree already belongs to thread ${existing}`);
    const path = await this.ownerPath(await this.managedCheckout(checkout));
    try {
      await writeFile(
        path,
        JSON.stringify({ version: 1, ownerThreadId: threadId }),
        { flag: "wx" },
      );
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      if ((await this.owner(checkout)) !== threadId)
        throw new Error("worktree was concurrently assigned to another thread");
    }
  }

  /** Removes a registered checkout, refusing ignored local files. */
  public async remove(sourceCwd: string, root: string): Promise<void> {
    const checkout = (await this.list(sourceCwd)).find(
      (entry) => entry.root === root,
    );
    if (!checkout)
      throw new CodexWorkspaceError(
        `${root} is not a managed worktree in this repository`,
      );
    if (isPathWithinDirectory(await realpath(sourceCwd), await realpath(root)))
      throw new CodexWorkspaceError(
        "switch to another checkout before deleting the current worktree",
      );
    const ignored = await workingTreeGit(checkout.root, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
    ]);
    if (ignored.length)
      throw new CodexWorkspaceError(
        "worktree contains ignored local files; remove them before deleting it",
      );
    await workingTreeGit(checkout.sourceRoot, ["worktree", "remove", root]);
    await removeEmptyBucket(root);
  }
}

export interface WorktreeFlowDeps {
  codexHome: () => string;
  readDesktopConfig: (cwd: string) => Promise<Record<string, unknown> | null>;
  getThreadSummary: (threadId: string) => Promise<CodexThreadSummary>;
  forkThread: (
    threadId: string,
    options?: { cwd?: string },
  ) => Promise<CodexThreadSummary>;
  createThread: (cwd: string) => Promise<CodexThreadSummary>;
  archiveThread?: (threadId: string) => Promise<void>;
  hasBackgroundTerminals?: (threadId: string) => Promise<boolean>;
  notify: () => void;
}

export const WORKTREE_BUSY_MESSAGE =
  "Creating a worktree requires an idle primary session without queued input.";

function retained(checkout: CodexManagedWorktree, reason: string): Error {
  return new Error(
    `${reason} A checkout was retained at ${checkout.root}; remove it with \`git worktree remove <checkout-path>\` from the source repository if it is no longer needed.`,
  );
}

/** Upstream `/worktree` flows with a per-source-thread creation lock. */
export class WorktreeService {
  private creating = new Set<string>();

  public constructor(private readonly deps: WorktreeFlowDeps) {}

  private async manager(cwd: string): Promise<WorktreeManager> {
    return new WorktreeManager(
      resolveWorktreeRoot(
        this.deps.codexHome(),
        await this.deps.readDesktopConfig(cwd).catch(() => null),
      ),
    );
  }

  private async sourceCwd(threadId: string, fallback?: string | null) {
    const summary = await this.deps.getThreadSummary(threadId);
    const cwd = summary.cwd || fallback?.trim() || "";
    if (!cwd)
      throw new CodexWorkspaceError(
        "Managed worktrees require a local Git repository.",
      );
    return { summary, cwd };
  }

  public async list(
    threadId: string,
    fallbackCwd?: string | null,
  ): Promise<CodexWorktreeList> {
    const { cwd } = await this.sourceCwd(threadId, fallbackCwd);
    const manager = await this.manager(cwd);
    const checkouts = await manager.list(cwd);
    const resolvedCwd = await realpath(cwd).catch(() => cwd);
    const entries = await Promise.all(
      checkouts.map(async (checkout): Promise<CodexWorktreeEntry> => {
        const ownerThreadId = await manager
          .owner(checkout.root)
          .catch(() => null);
        let owner: CodexWorktreeEntry["owner"] = {
          status: ownerThreadId ? "unavailable" : "none",
          title: null,
          updatedAt: null,
        };
        if (ownerThreadId) {
          const thread = await this.deps
            .getThreadSummary(ownerThreadId)
            .catch(() => null);
          if (thread) {
            const title =
              thread.name?.trim() ||
              thread.preview.split("\n")[0]?.trim() ||
              "Untitled conversation";
            owner = {
              status: "resumable",
              title:
                [...title].length > 80
                  ? `${[...title].slice(0, 79).join("")}…`
                  : title,
              updatedAt: thread.updatedAt,
            };
          }
        }
        return {
          ...checkout,
          ownerThreadId,
          owner,
          isCurrent: isPathWithinDirectory(
            resolvedCwd,
            await realpath(checkout.root).catch(() => checkout.root),
          ),
        };
      }),
    );
    return { root: manager.root, sourceCwd: cwd, entries };
  }

  public async start(
    threadId: string,
    mode: CodexWorktreeMode,
    fallbackCwd?: string | null,
  ): Promise<CodexWorktreeStartResult> {
    if (this.creating.has(threadId))
      throw new CodexWorkspaceError(
        "A worktree is already being created.",
        409,
      );
    this.creating.add(threadId);
    try {
      const { summary, cwd } = await this.sourceCwd(threadId, fallbackCwd);
      if (summary.status === "active")
        throw new CodexWorkspaceError(WORKTREE_BUSY_MESSAGE, 409);
      if (await this.deps.hasBackgroundTerminals?.(threadId).catch(() => false))
        throw new CodexWorkspaceError(
          "Active background terminals block /cd.",
          409,
        );
      const manager = await this.manager(cwd);
      const checkout = await manager.create(cwd);
      this.deps.notify();
      const after = await this.deps
        .getThreadSummary(threadId)
        .catch(() => null);
      if (!after || after.status === "active" || after.cwd !== summary.cwd)
        throw retained(
          checkout,
          "Cannot continue into the new worktree while the source session changed or is unavailable.",
        );
      let thread: CodexThreadSummary;
      try {
        thread =
          mode === "fork"
            ? await this.deps.forkThread(threadId, { cwd: checkout.cwd })
            : await this.deps.createThread(checkout.cwd);
      } catch (error) {
        throw retained(
          checkout,
          `Could not start a session in the managed worktree: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
      const discard = async () => {
        if (mode === "fork")
          await this.deps
            .archiveThread?.(thread.threadId)
            .catch(() => undefined);
      };
      if (
        thread.threadId === threadId ||
        (thread.cwd && resolve(thread.cwd) !== resolve(checkout.cwd))
      ) {
        await discard();
        throw retained(
          checkout,
          "Requested directory or permissions not applied.",
        );
      }
      try {
        await manager.bindThread(checkout.root, thread.threadId);
      } catch (error) {
        await discard();
        throw retained(
          checkout,
          `Cannot register managed worktree ownership: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
      this.deps.notify();
      return {
        mode,
        checkout,
        thread: { ...thread, cwd: thread.cwd || checkout.cwd },
        previousThreadId: threadId,
        warning: null,
      };
    } finally {
      this.creating.delete(threadId);
    }
  }

  public async remove(
    threadId: string,
    root: string,
    fallbackCwd?: string | null,
  ): Promise<{ message: string }> {
    const { cwd } = await this.sourceCwd(threadId, fallbackCwd);
    const manager = await this.manager(cwd);
    try {
      await manager.remove(cwd, root);
    } catch (error) {
      throw new CodexWorkspaceError(
        `Could not remove worktree at ${root}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.deps.notify();
    return { message: `Removed worktree at ${root}. Thread history was kept.` };
  }
}
