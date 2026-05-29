import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PI_DIR = join(homedir(), ".pi");
const PROJECT_PI_DIR = join(process.cwd(), ".pi");

/** Read a file from .pi/{relative} (project wins over ~/.pi). */
export function readPiFile(relative: string): string | null {
  let content: string | null = null;
  try {
    content = readFileSync(join(PI_DIR, relative), "utf-8").trim() || null;
  } catch {}
  try {
    content = readFileSync(join(PROJECT_PI_DIR, relative), "utf-8").trim() || null;
  } catch {}
  return content;
}

/** Get mtime of a file in ~/.pi/{relative}. */
export function piFileMtime(relative: string): Date | null {
  try {
    return statSync(join(PI_DIR, relative)).mtime;
  } catch {
    return null;
  }
}
