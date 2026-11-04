import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let dataDir = "";
let skillsDir = "";
beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-main-data-"));
  skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-main-skills-"));
  await Bun.write(path.join(skillsDir, "AGENTS.md"), "Be kind.\n");
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(skillsDir, { recursive: true, force: true });
});

function freePort() {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = probe;
  void probe.stop();
  return String(port);
}

async function waitForLine(lines: string[], text: string) {
  while (!lines.some((line) => line.includes(text))) await Bun.sleep(10);
}

test("a signal during startup stops the app cleanly", async () => {
  const child = Bun.spawn(
    ["bun", "--preload", "./src/main-fixture.ts", "src/main.ts"],
    {
      cwd: path.join(import.meta.dir, ".."),
      env: {
        PATH: process.env.PATH,
        PORT: freePort(),
        GATO_DATA_DIR: dataDir,
        GATO_SKILLS_DIR: skillsDir,
        GATO_COUNTRY: "PH",
        OPENROUTER_API_KEY: "k",
        GATO_MODEL: "base/model",
        GATO_CONNECTIONS: "slow",
        GATO_CONNECTION_SLOW_TYPE: "fake-slow-start",
      },
      stdout: "pipe",
    },
  );
  const lines: string[] = [];
  const reading = (async () => {
    for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream()))
      lines.push(...chunk.split("\n"));
  })();
  await waitForLine(lines, "fixture.start_waiting");
  child.kill("SIGTERM");
  expect(await child.exited).toBe(0);
  await reading;
  expect(lines.some((line) => line.includes('"app.stopping"'))).toBe(true);
  expect(await fs.exists(path.join(dataDir, ".gato.lock"))).toBe(false);
}, 20_000);
