import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

/** Private files are never served as package assets or returned by runtime reads. */
export class DeckPluginBackendStorage {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string) {}

  private async path(id: string, kind: string): Promise<string> {
    if (
      !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(id) ||
      !/^[a-z]+$/.test(kind)
    )
      throw new Error("Invalid private plugin path.");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const directory = join(this.root, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const path of [this.root, directory]) {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error(
          "Private plugin directories must be regular directories.",
        );
    }
    return join(directory, `${kind}.json`);
  }

  async read<T>(id: string, kind: string, fallback: T): Promise<T> {
    const path = await this.path(id, kind);
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error("Private plugin data must be a regular file.");
      if (kind === "secrets" && (stat.mode & 0o777) !== 0o600)
        await chmod(path, 0o600);
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw error;
    }
  }

  change<T>(
    id: string,
    kind: string,
    fallback: T,
    update: (value: T) => T,
  ): Promise<T> {
    const next = this.pending.then(async () => {
      const value = update(await this.read(id, kind, fallback));
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) > 4 * 1024 * 1024)
        throw new Error("Private plugin data exceeds 4 MiB.");
      const path = await this.path(id, kind);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      return value;
    });
    this.pending = next.catch(() => undefined);
    return next;
  }
}
