import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMAND_TIMEOUT_MS = 120_000;
const MACOS_RUN_TIMEOUT_MS = 60_000;
const MACOS_COMPILE_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Thrown when no translation backend can serve the request (HTTP 503). */
export class TranslationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranslationUnavailableError";
  }
}

export interface TranslateTextOptions {
  text: string;
  inputLang: string;
  outputLang: string;
  /** `translation_command` from the config file; wins over macOS built-in. */
  command?: string;
  /** Injectable for tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

/**
 * Translates `text` from `inputLang` to `outputLang`.
 *
 * Backend selection:
 * 1. `command` (translation_command config) — any platform, wins on macOS.
 * 2. macOS built-in Translation framework (darwin only).
 * 3. TranslationUnavailableError otherwise.
 */
export async function translateText(
  options: TranslateTextOptions,
): Promise<string> {
  const text = options.text;
  if (!text.trim()) {
    throw new Error("text must be a non-empty string");
  }
  const command = options.command?.trim();
  if (command) {
    return translateWithCommand(
      command,
      text,
      options.inputLang,
      options.outputLang,
    );
  }
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    return translateWithMacOSBuiltIn(
      text,
      options.inputLang,
      options.outputLang,
    );
  }
  throw new TranslationUnavailableError(
    "Translation is not available on this platform. Set translation_command in the codex-deck config.toml to enable translation.",
  );
}

/** Wraps a value in single quotes so it is one safe shell word. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Substitutes $PROMPT / $INPUT_LANG / $OUTPUT_LANG (and ${...} forms) with
 * shell-escaped values so the configured template stays safe to run via sh.
 */
export function expandTranslationCommand(
  template: string,
  vars: { prompt: string; inputLang: string; outputLang: string },
): string {
  return template.replace(
    /\$(?:\{(PROMPT|INPUT_LANG|OUTPUT_LANG)\}|(PROMPT|INPUT_LANG|OUTPUT_LANG))/g,
    (_match, braced: string | undefined, plain: string | undefined) => {
      const name = braced ?? plain;
      if (name === "PROMPT") {
        return shellQuote(vars.prompt);
      }
      if (name === "INPUT_LANG") {
        return shellQuote(vars.inputLang);
      }
      return shellQuote(vars.outputLang);
    },
  );
}

async function translateWithCommand(
  command: string,
  text: string,
  inputLang: string,
  outputLang: string,
): Promise<string> {
  const expanded = expandTranslationCommand(command, {
    prompt: text,
    inputLang,
    outputLang,
  });
  const { stdout, stderr } = await runProcess("/bin/sh", ["-c", expanded], {
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  const translated = stdout.replace(/\n+$/, "");
  if (!translated) {
    const detail = stderr.trim().slice(-300);
    throw new Error(
      `translation command produced no output${detail ? `: ${detail}` : ""}`,
    );
  }
  return translated;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

function runProcess(
  file: string,
  args: string[],
  options: { input?: string; timeoutMs: number },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(`process timed out after ${options.timeoutMs}ms: ${file}`));
    }, options.timeoutMs);
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES) {
        fail(new Error(`process output exceeded limit: ${file}`));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      fail(error);
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = (stderr.trim() || stdout.trim()).slice(-500);
      reject(
        new Error(
          `process exited with ${signal ?? `code ${code}`}: ${file}${detail ? ` — ${detail}` : ""}`,
        ),
      );
    });
    child.stdin.on("error", () => {
      // Ignore EPIPE when the child exits before consuming stdin.
    });
    if (options.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

/**
 * Swift helper using the macOS built-in Translation framework. Reads
 * `<sourceLang> <targetLang>` from argv and the text to translate from
 * stdin, then prints the translated text to stdout.
 */
const MACOS_TRANSLATE_SWIFT_SOURCE = `import Foundation
import Translation

enum TranslateCLIError: LocalizedError {
  case message(String)

  var errorDescription: String? {
    switch self {
    case .message(let text):
      return text
    }
  }
}

@main
struct CodexDeckTranslateCLI {
  static func main() async {
    do {
      let args = CommandLine.arguments
      guard args.count >= 3 else {
        throw TranslateCLIError.message(
          "usage: codex-deck-translate <sourceLang> <targetLang> (text on stdin)"
        )
      }
      let inputData = FileHandle.standardInput.readDataToEndOfFile()
      guard let text = String(data: inputData, encoding: .utf8), !text.isEmpty else {
        throw TranslateCLIError.message("stdin must contain UTF-8 text")
      }
      if #available(macOS 15, *) {
        let source = Locale.Language(identifier: args[1])
        let target = Locale.Language(identifier: args[2])
        let status = await LanguageAvailability().status(from: source, to: target)
        switch status {
        case .installed:
          break
        case .supported:
          throw TranslateCLIError.message(
            "macOS built-in translation supports \\(args[1]) -> \\(args[2]) but the language model is not installed. Download it in System Settings > General > Translation, or set translation_command in the codex-deck config.toml."
          )
        case .unsupported:
          throw TranslateCLIError.message(
            "macOS built-in translation does not support \\(args[1]) -> \\(args[2]). Set translation_command in the codex-deck config.toml instead."
          )
        @unknown default:
          break
        }
        let session = TranslationSession(installedSource: source, target: target)
        let response = try await session.translate(text)
        FileHandle.standardOutput.write(Data(response.targetText.utf8))
      } else {
        throw TranslateCLIError.message(
          "macOS built-in translation requires macOS 15 or later"
        )
      }
    } catch {
      FileHandle.standardError.write(
        Data("translation failed: \\(error.localizedDescription)\\n".utf8)
      )
      Foundation.exit(1)
    }
  }
}
`;

let macOSBinaryPromise: Promise<string> | null = null;

function getMacOSTranslateBinary(): Promise<string> {
  macOSBinaryPromise ??= compileMacOSTranslateBinary().catch((error) => {
    // Allow a later request to retry the compile.
    macOSBinaryPromise = null;
    throw error;
  });
  return macOSBinaryPromise;
}

async function compileMacOSTranslateBinary(): Promise<string> {
  const hash = createHash("sha1")
    .update(MACOS_TRANSLATE_SWIFT_SOURCE)
    .digest("hex")
    .slice(0, 16);
  const binaryPath = join(tmpdir(), `codex-deck-translate-${hash}`);
  if (existsSync(binaryPath)) {
    return binaryPath;
  }
  const sourcePath = `${binaryPath}.swift`;
  writeFileSync(sourcePath, MACOS_TRANSLATE_SWIFT_SOURCE, "utf-8");
  try {
    await runProcess(
      "swiftc",
      ["-O", "-parse-as-library", sourcePath, "-o", binaryPath],
      { timeoutMs: MACOS_COMPILE_TIMEOUT_MS },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TranslationUnavailableError(
      `Failed to build the macOS built-in translation helper (needs Xcode Command Line Tools). Set translation_command in config.toml to use a custom command instead. Detail: ${message}`,
    );
  }
  try {
    unlinkSync(sourcePath);
  } catch {
    // Best-effort cleanup only.
  }
  return binaryPath;
}

async function translateWithMacOSBuiltIn(
  text: string,
  inputLang: string,
  outputLang: string,
): Promise<string> {
  const binaryPath = await getMacOSTranslateBinary();
  const { stdout } = await runProcess(binaryPath, [inputLang, outputLang], {
    input: text,
    timeoutMs: MACOS_RUN_TIMEOUT_MS,
  });
  const translated = stdout.replace(/\n+$/, "");
  if (!translated) {
    throw new Error("macOS built-in translation produced no output");
  }
  return translated;
}
