import type { ComponentType } from "react";
import type { RightPaneToolProps } from "./types";
import files from "../files/client";
import git from "../git/client";
import tasks from "../tasks/client";
import skills from "../skills/client";
import hooks from "../hooks/client";
import process from "../process/client";
export const toolViews: Record<
  string,
  ComponentType<RightPaneToolProps> | undefined
> = { files, git, tasks, skills, hooks, process };
