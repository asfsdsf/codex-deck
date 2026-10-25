import { createReadStream, createWriteStream, rmSync } from "node:fs";
import { mkdtemp, open, rm, stat, link, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Decompress } from "fzstd";

export const isRolloutFile = (path: string) => /\.jsonl(?:\.zst)?$/i.test(path);
export const plainRolloutPath = (path: string) => path.replace(/\.zst$/i, "");

/** Prefer the writable representation, tolerating an upstream compression transition. */
export async function resolveRolloutSource(path: string): Promise<string> {
  const plain = plainRolloutPath(path);
  try {
    await stat(plain);
    return plain;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await stat(`${plain}.zst`);
  return `${plain}.zst`;
}

/** Read discovery metadata without decoding or caching the rest of a rollout. */
export async function readRolloutPrefix(
  path: string,
  maxBytes = 64 * 1024,
): Promise<Buffer> {
  const source = await resolveRolloutSource(path);
  if (!source.endsWith(".zst")) {
    const handle = await open(source, "r");
    try {
      const buffer = Buffer.allocUnsafe(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
  const chunks: Buffer[] = [];
  let remaining = maxBytes;
  const complete = Symbol("prefix complete");
  const decoder = new Decompress((chunk) => {
    const length = Math.min(remaining, chunk.length);
    chunks.push(Buffer.from(chunk.subarray(0, length)));
    remaining -= length;
    if (!remaining) throw complete;
  });
  try {
    for await (const chunk of createReadStream(source, {
      highWaterMark: 4096,
    })) {
      decoder.push(chunk);
    }
    decoder.push(new Uint8Array(), true);
  } catch (error) {
    if (error !== complete) throw error;
  }
  return Buffer.concat(chunks);
}

/** Source stats are cheap; decoded stats require reading the complete history. */
export async function statRolloutSource(path: string) {
  return stat(await resolveRolloutSource(path));
}

let cacheDirectory: Promise<string> | undefined;
const cache = new Map<string, { path: string; source: string }>();
const pending = new Map<string, Promise<string>>();
const opening = new Map<string, number>();

async function evictRollouts(): Promise<void> {
  const removals: Promise<unknown>[] = [];
  for (const [key, entry] of cache) {
    if (cache.size <= 32) break;
    if (opening.has(entry.source)) continue;
    cache.delete(key);
    // Already-open handles remain readable. Unique filenames prevent a later
    // decode from racing deletion of an earlier cache entry.
    removals.push(rm(entry.path, { force: true }).catch(() => {}));
  }
  await Promise.all(removals);
}

function directory(): Promise<string> {
  return (cacheDirectory ??= mkdtemp(
    join(tmpdir(), "codex-deck-rollouts-"),
  ).then((path) => {
    process.once("exit", () => rmSync(path, { recursive: true, force: true }));
    return path;
  }));
}

/** Decode to a private temporary file so all existing byte-window readers stay bounded. */
async function readableRolloutPath(path: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const source = await resolveRolloutSource(path);
    if (!source.endsWith(".zst")) return source;
    const stats = await stat(source);
    const signature = `${source}:${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
    const cached = cache.get(signature);
    if (cached) {
      cache.delete(signature);
      cache.set(signature, cached);
      return cached.path;
    }
    const active = pending.get(signature);
    if (active) return active;
    const task = (async () => {
      const target = join(await directory(), randomUUID() + ".jsonl");
      const decoder = new Transform({
        transform(chunk, _encoding, callback) {
          try {
            decompress.push(chunk);
            callback();
          } catch (error) {
            callback(error as Error);
          }
        },
        flush(callback) {
          try {
            decompress.push(new Uint8Array(), true);
            callback();
          } catch (error) {
            callback(error as Error);
          }
        },
      });
      const decompress = new Decompress((chunk) => decoder.push(chunk));
      try {
        await pipeline(
          createReadStream(source),
          decoder,
          createWriteStream(target, { mode: 0o600 }),
        );
        const current = await stat(source);
        if (
          current.ino !== stats.ino ||
          current.size !== stats.size ||
          current.mtimeMs !== stats.mtimeMs ||
          current.ctimeMs !== stats.ctimeMs
        )
          throw new Error("Rollout changed during decompression");
        cache.set(signature, {
          path: target,
          source: resolve(plainRolloutPath(source)),
        });
        await evictRollouts();
        return target;
      } catch (error) {
        await rm(target, { force: true });
        throw error;
      }
    })();
    pending.set(signature, task);
    try {
      return await task;
    } catch (error) {
      if (attempt === 2) throw error;
    } finally {
      pending.delete(signature);
    }
  }
  throw new Error("Unable to read rollout");
}

export async function openRollout(path: string, _flags: "r" = "r") {
  const source = resolve(plainRolloutPath(path));
  opening.set(source, (opening.get(source) ?? 0) + 1);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await open(await readableRolloutPath(path), "r");
      } catch (error) {
        if (attempt >= 2 || (error as NodeJS.ErrnoException).code !== "ENOENT")
          throw error;
        await delay(25);
      }
    }
  } finally {
    const remaining = opening.get(source)! - 1;
    if (remaining) opening.set(source, remaining);
    else opening.delete(source);
    await evictRollouts();
  }
}
export async function statRollout(path: string) {
  const handle = await openRollout(path);
  try {
    return await handle.stat();
  } finally {
    await handle.close();
  }
}
export async function readRolloutText(
  path: string,
  _encoding: "utf-8" = "utf-8",
) {
  const handle = await openRollout(path);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** Explicit edits must target Codex's real writable file, never the read cache. */
export async function materializeRolloutForWrite(
  path: string,
): Promise<string> {
  const plain = plainRolloutPath(path);
  const source = await resolveRolloutSource(path);
  if (source === plain) return plain;
  const content = await readRolloutText(source);
  // Exclusive creation avoids overwriting a file materialized concurrently by Codex.
  const temporary = `${plain}.codex-deck-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await link(temporary, plain).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  } finally {
    await rm(temporary, { force: true });
  }
  return plain;
}
