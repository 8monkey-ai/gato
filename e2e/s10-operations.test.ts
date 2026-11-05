import { expect, test } from "bun:test";
import { join } from "node:path";

import { launch, tempDir, waitFor } from "./support/app.ts";
import { useTelegram } from "./support/fixture.ts";
import { readState, telegramEnv } from "./support/setup.ts";

const f = useTelegram();

test("§10 readiness is reported on the health route", async () => {
  const app = await f.start();
  const response = await fetch(`${app.url}/health`);
  expect(response.status).toBe(200);
  expect(((await response.json()) as { ready: boolean }).ready).toBe(true);
});

test("§10 missing country prevents startup", async () => {
  const env = telegramEnv(f.gateway, f.telegram, { DATA_DIR: await tempDir() });
  const { child, logs } = launch({ ...env, COUNTRY: "" });
  expect(await child.exited).toBe(1);
  await Bun.sleep(50);
  expect(logs.join("\n")).toContain("Missing COUNTRY");
});

test("§10 unsupported country prevents startup", async () => {
  const env = telegramEnv(f.gateway, f.telegram, { DATA_DIR: await tempDir() });
  const { child, logs } = launch({ ...env, COUNTRY: "SG" });
  expect(await child.exited).toBe(1);
  await Bun.sleep(50);
  expect(logs.join("\n")).toContain("Use one of: MY, PH");
});

test("§10 storage that is not writable prevents startup instead of using an empty history elsewhere", async () => {
  const blocked = join(await tempDir(), "file");
  await Bun.write(blocked, "not a folder");
  const { child } = launch(
    telegramEnv(f.gateway, f.telegram, { DATA_DIR: blocked }),
  );
  expect(await child.exited).toBe(1);
});

test("§10 shutdown stops within the bound and preserves unfinished work for the next start", async () => {
  f.gateway.reply({
    text: "slow ".repeat(200),
    chunkSize: 2,
    chunkDelayMs: 30,
  });
  const app = await f.start({
    SHUTDOWN_GRACE: "200ms",
    DELIVERY_BOUNDARY: "whole",
  });
  f.telegram.customerMessage(1, { text: "Please answer" });
  await waitFor(() => f.gateway.requests.length === 1);
  const started = Date.now();
  expect(await app.stop()).toBe(0);
  expect(Date.now() - started).toBeLessThan(3000);
  expect((await readState(app.dataDir, "tg", "1")).pendingReply).toBe(true);
  f.gateway.reply({ text: "Answer after restart" });
  await f.restart();
  await waitFor(() => f.telegram.sentTexts(1).includes("Answer after restart"));
});
