import { expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readDataDir } from "../../src/storage/data-dir.ts";
import { tmpDataDir } from "../support/data-dir.ts";
import { openTestStore } from "../support/store.ts";

test("a missing directory stops startup with an actionable message", async () => {
  const dataDir = join(await tmpDataDir(), "absent");
  await expect(openTestStore(dataDir)).rejects.toThrow(
    new Error(
      `Data directory ${dataDir} does not exist. Create it or mount the storage volume at this path.`,
    ),
  );
});

// Root ignores file permissions, so the directory stays writable.
test.skipIf(process.getuid?.() === 0)(
  "a directory without write access stops startup with an actionable message",
  async () => {
    const dataDir = await tmpDataDir();
    await chmod(dataDir, 0o500);
    await expect(openTestStore(dataDir)).rejects.toThrow(
      new Error(
        `Data directory ${dataDir} is not writable (EACCES). Give the Gato process write access to it.`,
      ),
    );
  },
);

test("GATO_DATA_DIR is required and absolute", () => {
  expect(readDataDir({ GATO_DATA_DIR: "/data" })).toBe("/data");
  expect(() => readDataDir({})).toThrow(new Error("GATO_DATA_DIR: Required"));
  expect(() => readDataDir({ GATO_DATA_DIR: "data" })).toThrow(
    new Error("GATO_DATA_DIR: expected an absolute path"),
  );
});

test("ignores files and hidden folders in the data directory", async () => {
  const dataDir = await tmpDataDir();
  await mkdir(join(dataDir, ".trash", "1"), { recursive: true });
  await writeFile(join(dataDir, "notes.txt"), "");
  const store = await openTestStore(dataDir);
  const chats = [];
  for await (const ref of store.chats()) chats.push(ref);
  expect(chats).toEqual([]);
});
