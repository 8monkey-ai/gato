import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { acquireInstanceLock } from "./instance-lock.ts";

let dataDir = "";
beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-lock-"));
});
afterEach(() => fs.rm(dataDir, { recursive: true, force: true }));

test("holds the lock until release", async () => {
  const release = await acquireInstanceLock(dataDir);
  expect(await fs.readFile(path.join(dataDir, ".gato.lock"), "utf8")).toBe(
    String(process.pid),
  );
  await expect(acquireInstanceLock(dataDir)).rejects.toThrow(
    "is in use by process",
  );
  await release();
  const again = await acquireInstanceLock(dataDir);
  await again();
});

test("takes over a lock left by a process that ended", async () => {
  const ended = Bun.spawnSync(["true"]).pid;
  await fs.writeFile(path.join(dataDir, ".gato.lock"), String(ended));
  const release = await acquireInstanceLock(dataDir);
  expect(await fs.readFile(path.join(dataDir, ".gato.lock"), "utf8")).toBe(
    String(process.pid),
  );
  await release();
});
