import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import { type Env, readEnv } from "../config/env.ts";
import { isMissing } from "./files.ts";

const safeName = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export function readDataDir(env: Env = process.env): string {
  return readEnv(
    "GATO_DATA_DIR",
    z.string().refine(isAbsolute, "expected an absolute path"),
    env,
  );
}

/** Throws with an actionable message unless `dir` is a directory this process can write to. */
export async function checkWritable(dir: string): Promise<void> {
  const info = await stat(dir).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
    throw new Error(
      `Data directory ${dir} does not exist. Create it or mount the storage volume at this path.`,
    );
  });
  if (!info.isDirectory()) {
    throw new Error(`Data directory ${dir} is not a directory.`);
  }
  const probe = join(dir, ".gato-write-check");
  try {
    await writeFile(probe, "");
    await rm(probe);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    throw new Error(
      `Data directory ${dir} is not writable (${code}). Give the Gato process write access to it.`,
      { cause: error },
    );
  }
}

/** Throws unless `name` can be one folder name: no separators, no leading dot. */
export function checkFolderName(name: string, what: string): void {
  if (!safeName.test(name)) {
    throw new Error(
      `${what} ${JSON.stringify(name)} cannot be a folder name. Use letters, digits, ".", "_" and "-", not starting with ".".`,
    );
  }
}

/** `[connection, chatKey]` of each chat folder, sorted. Other entries are ignored. */
export async function listChatFolders(
  dataDir: string,
): Promise<Array<[string, string]>> {
  const folders: Array<[string, string]> = [];
  for (const connection of await subfolders(dataDir)) {
    for (const chatKey of await subfolders(join(dataDir, connection))) {
      folders.push([connection, chatKey]);
    }
  }
  return folders;
}

async function subfolders(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && safeName.test(entry.name))
    .map((entry) => entry.name)
    .toSorted();
}
