import fs from "node:fs/promises";
import path from "node:path";

// Lock files this process created. A lock file with this process id that is not in the set is stale:
// a container restarts with the same process id (often 1) after a crash.
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
    await fs.writeFile(file, String(process.pid), { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function inUseBy(file: string): Promise<number | undefined> {
  const pid = Number(await fs.readFile(file, "utf8").catch(() => ""));
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (pid === process.pid) return held.has(file) ? pid : undefined;
  return isAlive(pid) ? pid : undefined;
}

export async function acquireInstanceLock(dataDir: string) {
  const file = path.join(dataDir, ".gato.lock");
  if (!(await createLock(file))) {
    const pid = await inUseBy(file);
    if (pid !== undefined)
      throw new Error(`Data folder ${dataDir} is in use by process ${pid}`);
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
