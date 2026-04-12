import type { CodexSkillMetadata } from "@codex-deck/api";

export const WORKFLOW_REQUIRED_SKILL_NAME = "codex-deck-flow";
export const WORKFLOW_REQUIRED_SKILL_INSTALL_REPO = "asfsdsf/codex-deck";
export const WORKFLOW_REQUIRED_SKILL_INSTALL_BRANCH = "main";
export const WORKFLOW_REQUIRED_SKILL_INSTALL_PATH = "skills/codex-deck-flow";

export type WorkflowSkillInstallChoice = "local" | "global" | "cancel";

export interface WorkflowSkillAvailability {
  hasProjectLocalInstall: boolean;
  hasGlobalInstall: boolean;
  isInstalled: boolean;
}

function normalizePathForComparison(inputPath: string): string {
  const normalized = inputPath.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[A-Za-z]:\//.test(normalized)) {
    return normalized.toLowerCase();
  }
  return normalized;
}

function isGlobalSkillScope(scope: CodexSkillMetadata["scope"]): boolean {
  return scope === "user" || scope === "admin" || scope === "system";
}

function isPathWithinProjectRoot(path: string, projectRoot: string): boolean {
  const normalizedPath = normalizePathForComparison(path);
  const normalizedProjectRoot = normalizePathForComparison(projectRoot);
  if (!normalizedPath || !normalizedProjectRoot) {
    return false;
  }
  return (
    normalizedPath === normalizedProjectRoot ||
    normalizedPath.startsWith(`${normalizedProjectRoot}/`)
  );
}

function isGlobalSkillPath(path: string): boolean {
  return normalizePathForComparison(path).includes("/.codex/skills/");
}

export function getWorkflowSkillAvailability(
  skills: CodexSkillMetadata[],
  projectRoot: string | null | undefined,
): WorkflowSkillAvailability {
  const normalizedProjectRoot = projectRoot?.trim() ?? "";
  let hasProjectLocalInstall = false;
  let hasGlobalInstall = false;

  for (const skill of skills) {
    if (skill.name.trim().toLowerCase() !== WORKFLOW_REQUIRED_SKILL_NAME) {
      continue;
    }

    if (
      skill.scope === "repo" ||
      (normalizedProjectRoot &&
        isPathWithinProjectRoot(skill.path, normalizedProjectRoot))
    ) {
      hasProjectLocalInstall = true;
      continue;
    }

    if (isGlobalSkillScope(skill.scope) || isGlobalSkillPath(skill.path)) {
      hasGlobalInstall = true;
    }
  }

  return {
    hasProjectLocalInstall,
    hasGlobalInstall,
    isInstalled: hasProjectLocalInstall || hasGlobalInstall,
  };
}

export function buildWorkflowSkillInstallMessagePrefix(
  choice: Exclude<WorkflowSkillInstallChoice, "cancel">,
): string {
  const installSource = `GitHub repo ${WORKFLOW_REQUIRED_SKILL_INSTALL_REPO}, branch ${WORKFLOW_REQUIRED_SKILL_INSTALL_BRANCH}, path ${WORKFLOW_REQUIRED_SKILL_INSTALL_PATH}`;
  if (choice === "local") {
    return `$skill-installer install the codex-deck-flow skill from ${installSource}, into the appropriate project-local skills destination that you infer automatically from the local context. Do not install globally. Then do following: `;
  }

  return `$skill-installer install the codex-deck-flow skill globally from ${installSource}, using the default global Codex skills directory. Then do following: `;
}
