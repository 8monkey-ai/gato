import { afterEach } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created: string[] = [];

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await chmod(dir, 0o700);
    await rm(dir, { recursive: true, force: true });
  }
});

/** An empty data directory, removed after the test. */
export async function tmpDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gato-data-"));
  created.push(dir);
  return dir;
}
