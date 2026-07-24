import { homedir } from "node:os";
import { join } from "node:path";

export function resolveDefaultCodexHome(
  codexHome = process.env.CODEX_HOME,
  userHome = homedir(),
): string {
  return codexHome?.trim() || join(userHome, ".codex");
}
