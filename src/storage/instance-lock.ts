import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Lock files this process created. A lock file with this host and process id that is not in the set is stale:
// a container restarts with the same hostname and process id (often 1) after a crash.
const held = new Set<string>();

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function createLock(file: string): Promise<boolean> {
  try {
    await fs.writeFile(file, `${os.hostname()}:${process.pid}`, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

// A lock file with only a process id comes from an older version that wrote no hostname.
async function readHolder(file: string) {
  const content = (await fs.readFile(file, "utf8").catch(() => "")).trim();
  const separator = content.lastIndexOf(":");
  const host = separator < 0 ? undefined : content.slice(0, separator);
  return { host, pid: Number(content.slice(separator + 1)), content };
}

// Returns why the lock cannot be taken over, or undefined when it is stale.
async function refusal(file: string, dataDir: string) {
  const { host, pid, content } = await readHolder(file);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (host !== undefined && host !== os.hostname())
    return `Data folder ${dataDir} is locked by ${content} on another host. Make sure that no other instance uses it, then delete ${file}`;
  const own = pid === process.pid;
  const inUse = own ? host !== undefined && held.has(file) : isAlive(pid);
  return inUse
    ? `Data folder ${dataDir} is in use by ${content} (lock file ${file})`
    : undefined;
}

export async function acquireInstanceLock(dataDir: string) {
  const file = path.join(dataDir, ".gato.lock");
  if (!(await createLock(file))) {
    const refused = await refusal(file, dataDir);
    if (refused !== undefined) throw new Error(refused);
    await fs.rm(file, { force: true });
    if (!(await createLock(file)))
      throw new Error(`Data folder ${dataDir} was locked by another process`);
  }
  held.add(file);
  return async () => {
    held.delete(file);
    await fs.rm(file, { force: true });
  };
}
