import { open, readFile, rename } from "node:fs/promises";

/** Readers see the old or the new content, never a part. */
export async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.tmp`;
  await writeSynced(temp, "w", text);
  await rename(temp, path);
}

/** Resolves after the text is on disk. */
export async function appendSynced(path: string, text: string): Promise<void> {
  await writeSynced(path, "a", text);
}

/** Makes the entries of `dir` lasting, for example a new file or folder in it. */
export async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The content, or undefined when the file does not exist. */
export async function readIfExists(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function writeSynced(
  path: string,
  flags: "w" | "a",
  text: string,
): Promise<void> {
  const file = await open(path, flags);
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
}
