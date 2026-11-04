import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { acquireInstanceLock } from "./instance-lock.ts";

let dataDir = "";
let lockFile = "";
beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-lock-"));
  lockFile = path.join(dataDir, ".gato.lock");
});
afterEach(() => fs.rm(dataDir, { recursive: true, force: true }));

const here = (pid: number) => `${os.hostname()}:${pid}`;
const endedPid = () => Bun.spawnSync(["true"]).pid;

test("writes the hostname and process id and holds the lock until release", async () => {
  const release = await acquireInstanceLock(dataDir);
  expect(await fs.readFile(lockFile, "utf8")).toBe(here(process.pid));
  await expect(acquireInstanceLock(dataDir)).rejects.toThrow(
    `is in use by ${here(process.pid)} (lock file ${lockFile})`,
  );
  await release();
  const again = await acquireInstanceLock(dataDir);
  await again();
});

test("takes over a lock left by a process on this host that ended", async () => {
  await fs.writeFile(lockFile, here(endedPid()));
  const release = await acquireInstanceLock(dataDir);
  expect(await fs.readFile(lockFile, "utf8")).toBe(here(process.pid));
  await release();
});

test("takes over a lock with this hostname and process id from before a restart", async () => {
  await fs.writeFile(lockFile, here(process.pid));
  const release = await acquireInstanceLock(dataDir);
  await expect(acquireInstanceLock(dataDir)).rejects.toThrow("is in use by");
  await release();
});

test("refuses a lock from another host even when its process id is not alive here", async () => {
  await fs.writeFile(lockFile, `other-host:${endedPid()}`);
  await expect(acquireInstanceLock(dataDir)).rejects.toThrow(
    `is locked by other-host:`,
  );
  await expect(acquireInstanceLock(dataDir)).rejects.toThrow(
    `then delete ${lockFile}`,
  );
  expect(await fs.readFile(lockFile, "utf8")).toStartWith("other-host:");
});

test("a lock with only a process id is in use only while that other process is alive", async () => {
  await fs.writeFile(lockFile, String(process.ppid));
  await expect(acquireInstanceLock(dataDir)).rejects.toThrow(
    `is in use by ${process.ppid}`,
  );
  await fs.writeFile(lockFile, String(process.pid));
  await (
    await acquireInstanceLock(dataDir)
  )();
  await fs.writeFile(lockFile, String(endedPid()));
  await (
    await acquireInstanceLock(dataDir)
  )();
});
