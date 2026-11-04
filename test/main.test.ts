import { expect, test } from "bun:test";
import { join } from "node:path";

import { tmpDataDir } from "./support/data-dir.ts";

const main = join(import.meta.dir, "..", "src", "main.ts");

function startMain(env: Record<string, string>) {
  return Bun.spawn(["bun", main], {
    env: { PATH: process.env.PATH, ...env },
    stdout: "pipe",
  });
}

async function readUntil(stream: ReadableStream<Uint8Array>, text: string) {
  const decoder = new TextDecoder();
  let output = "";
  for await (const chunk of stream) {
    output += decoder.decode(chunk, { stream: true });
    if (output.includes(text)) break;
  }
  return output;
}

test("serves until SIGTERM, then stops and ends with code 0", async () => {
  const app = startMain({ GATO_DATA_DIR: await tmpDataDir(), GATO_PORT: "0" });
  expect(await readUntil(app.stdout, '"msg":"listening"')).toContain(
    '"msg":"listening"',
  );
  app.kill("SIGTERM");
  expect(await app.exited).toBe(0);
});

test("stops startup with code 1 and names a missing variable", async () => {
  const app = startMain({});
  const output = await new Response(app.stdout).text();
  expect(await app.exited).toBe(1);
  expect(output).toContain("GATO_DATA_DIR: Required");
});
