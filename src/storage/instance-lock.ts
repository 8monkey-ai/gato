import fs from "node:fs/promises";
import path from "node:path";

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

export async function acquireInstanceLock(dataDir: string) {
  const file = path.join(dataDir, ".gato.lock");
  if (!(await createLock(file))) {
    const pid = Number(await fs.readFile(file, "utf8").catch(() => ""));
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid))
      throw new Error(`Data folder ${dataDir} is in use by process ${pid}`);
    await fs.rm(file, { force: true });
    if (!(await createLock(file)))
      throw new Error(`Data folder ${dataDir} was locked by another process`);
  }
  return () => fs.rm(file, { force: true });
}
