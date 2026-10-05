import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { CodexAppServerClientFacade } from "./codex-app-server";
import type {
  DiffGuideStartRequest,
  DiffGuideStartResponse,
  DiffGuideSummary,
} from "./storage";
import {
  DiffGuideStore,
  validateDiffGuideId,
  type DiffGuideRecord,
} from "./diff-guide-store";

const runFile = promisify(execFile);

export async function checkDiffGuideTools(cwd: string): Promise<string> {
  try {
    const { stdout } = await runFile(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      { timeout: 10_000 },
    );
    await runFile("python3", ["--version"], { timeout: 10_000 });
    return stdout.trim();
  } catch {
    throw new Error(
      "Diff guides require a Git working tree, git, and python3 on the CLI machine.",
    );
  }
}

export function buildDiffGuidePrompt(
  record: DiffGuideRecord,
  directory: string,
): string {
  const install = record.skillInstallChoice
    ? `$skill-installer install codex-deck-diff from GitHub repo asfsdsf/codex-deck, branch main, path skills/codex-deck-diff, ${record.skillInstallChoice === "local" ? "into the appropriate project-local Codex skills directory" : "into the active CODEX_HOME global skills directory"}. Read the installed SKILL.md and use it in this turn even if skill discovery needs a refresh. Stop and explain if installation fails.\n\n`
    : "";
  return `${install}$codex-deck-diff\n\nGenerate a guided Git diff tour in this fork. Inherited conversation history is background context. This request is the current task. Inspect source without editing, staging, fetching, or committing repository code (except an explicitly chosen skill installation).\n\nRepository: ${JSON.stringify(record.projectRoot)}\nSource session: ${record.parentSessionId}\nFork session: ${record.sessionId}\n\nMandatory artifact directory: ${JSON.stringify(directory)}\nCapture snapshot: ${JSON.stringify(join(directory, "snapshot.json"))}\nAuthor guide: ${JSON.stringify(join(directory, "guide.json"))}\nPublish HTML: ${JSON.stringify(join(directory, "diff-tour.html"))}\n\nThese explicit destinations override any temporary output defaults in the skill. Default to HEAD versus current staged, unstaged, and non-ignored untracked code. Honor any commit/branch/tag baseline, language, and exclusions requested below using the skill's existing arguments. Compare the baseline directly against current code. Exclude this artifact directory during capture if it is inside the repository. Always capture with --omit-source so snapshot.json contains diff hunks and source identities without compressed blobs or hidden full source. Build from this source-free snapshot; source is reconstructed from the recorded Git baseline and captured diff, never from later working-tree edits. Copy the snapshot comparison metadata exactly into guide.json. Build using --snapshot and --manifest, writing to diff-tour.build.html in this directory, then atomically rename it to diff-tour.html only after the build succeeds. Do not change session.json. If there are no changes, explain that in the session and do not publish an empty tour. Report the final artifact paths.\n\nUser request (preserved verbatim):\n${record.prompt || "Create a guide explaining the current Git changes."}`;
}

export class DiffGuideService {
  private pending = new Map<string, Promise<DiffGuideStartResponse>>();
  private pendingInputs = new Map<
    string,
    { sourceSessionId: string; prompt: string }
  >();
  constructor(
    readonly store: DiffGuideStore,
    private client: () => CodexAppServerClientFacade,
    private resolveProject: (
      sessionId: string,
    ) => Promise<string | null | undefined>,
    private checkTools = checkDiffGuideTools,
  ) {}

  start(input: DiffGuideStartRequest): Promise<DiffGuideStartResponse> {
    validateDiffGuideId(input.requestId);
    validateDiffGuideId(input.sourceSessionId);
    const key = input.requestId;
    const pending = this.pending.get(key);
    if (pending) {
      const previous = this.pendingInputs.get(key)!;
      if (
        previous.sourceSessionId !== input.sourceSessionId ||
        previous.prompt !== (input.prompt ?? "")
      ) {
        return Promise.reject(
          new Error("Request ID belongs to a different diff guide request"),
        );
      }
      return pending;
    }
    const work = this.startOnce(input);
    this.pending.set(key, work);
    this.pendingInputs.set(key, {
      sourceSessionId: input.sourceSessionId,
      prompt: input.prompt ?? "",
    });
    void work
      .finally(() => {
        this.pending.delete(key);
        this.pendingInputs.delete(key);
      })
      .catch(() => {});
    return work;
  }

  private async startOnce(
    input: DiffGuideStartRequest,
  ): Promise<DiffGuideStartResponse> {
    const client = this.client();
    let record = await this.store.findRequest(input.requestId);
    if (
      record &&
      (record.parentSessionId !== input.sourceSessionId ||
        record.prompt !== (input.prompt ?? ""))
    ) {
      throw new Error("Request ID belongs to a different diff guide request");
    }
    if (record && !input.retry) return this.response(record);
    if (record) {
      const state = await client.getThreadState(
        record.sessionId,
        record.turnId,
      );
      if (state.isGenerating) {
        if (state.activeTurnId) {
          record.turnId = state.activeTurnId;
          record.status = "generating";
          record.error = null;
          await this.store.write(record);
        }
        return this.response(record);
      }
      if (await this.store.content(record, false)) return this.response(record);
      if (record.skillInstallChoice && client.listSkills) {
        const entries = await client.listSkills({ cwd: record.projectRoot });
        if (
          entries.some((entry) =>
            entry.skills.some(
              (skill) => skill.name === "codex-deck-diff" && skill.enabled,
            ),
          )
        )
          record.skillInstallChoice = null;
      }
    } else {
      if (!client.forkThread || !client.listSkills)
        throw new Error(
          "Thread forking and skill discovery are required for diff guides.",
        );
      const cwd = await this.resolveProject(input.sourceSessionId);
      if (!cwd)
        throw new Error(
          "Select an existing session with a project directory before creating a diff guide.",
        );
      const projectRoot = await this.checkTools(cwd);
      const entries = await client.listSkills({ cwd });
      const entry = entries.find((value) => value.cwd === cwd) ?? entries[0];
      if (entry?.errors.length)
        throw new Error(
          `Skill discovery failed: ${entry.errors.map((error) => error.message).join("; ")}`,
        );
      const skills = (entry?.skills ?? []).filter(
        (skill) => skill.name.trim().toLowerCase() === "codex-deck-diff",
      );
      if (skills.length && !skills.some((skill) => skill.enabled)) {
        throw new Error(
          "codex-deck-diff is disabled. Enable it in this session's Skills settings first.",
        );
      }
      if (!skills.length && !input.skillInstallChoice)
        return { status: "needs_skill_install", projectRoot };
      await this.store.prepare();
      const thread = await client.forkThread(input.sourceSessionId);
      record = {
        sessionId: thread.threadId,
        parentSessionId: input.sourceSessionId,
        requestId: input.requestId,
        projectRoot,
        prompt: input.prompt ?? "",
        model: input.model,
        effort: input.effort,
        skillInstallChoice: !skills.length ? input.skillInstallChoice : null,
        thread,
        turnId: null,
        status: "starting",
        error: null,
      };
      await this.store.write(record);
    }
    // Persist the fork before sending. An uncertain send is retried only explicitly.
    record.status = "starting";
    record.error = null;
    await this.store.write(record);
    try {
      const result = await client.sendMessage({
        threadId: record.sessionId,
        cwd: record.projectRoot,
        input: [
          {
            type: "text",
            text: buildDiffGuidePrompt(
              record,
              this.store.directory(record.sessionId),
            ),
          },
        ],
        model: record.model,
        effort: record.effort,
        collaborationMode: {
          mode: "default",
          settings: { model: record.model, reasoningEffort: record.effort },
        },
      });
      record.turnId = result.turnId;
      record.status = "generating";
      await this.store.write(record);
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      await this.store.write(record);
    }
    return this.response(record);
  }

  private async response(
    record: DiffGuideRecord,
  ): Promise<DiffGuideStartResponse> {
    return {
      status: record.status === "failed" ? "failed" : "started",
      guide: await this.summary(record),
      thread: record.thread,
      turnId: record.turnId,
    };
  }

  async summary(record: DiffGuideRecord): Promise<DiffGuideSummary> {
    const summary = await this.store.summary(record);
    if (summary.status === "generating" && record.turnId) {
      try {
        const state = await this.client().getThreadState(
          record.sessionId,
          record.turnId,
        );
        if (
          state.requestedTurnStatus &&
          state.requestedTurnStatus !== "inProgress"
        ) {
          summary.status =
            state.requestedTurnStatus === "completed"
              ? "unavailable"
              : "failed";
          summary.error =
            "Generation ended without a complete guide. Check the conversation for details, then retry if needed.";
        }
      } catch {
        /* Keep artifacts accessible if the app-server is temporarily unavailable. */
      }
    }
    return summary;
  }

  async summaries(): Promise<DiffGuideSummary[]> {
    return Promise.all(
      (await this.store.records()).map((record) => this.summary(record)),
    );
  }
}
