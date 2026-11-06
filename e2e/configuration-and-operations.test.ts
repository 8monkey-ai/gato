import { expect, test } from "bun:test";

import { readChat, startApp } from "./support/app.ts";
import { until } from "./support/recorder.ts";
import { startHarness } from "./support/setup.ts";

const noRespondio = {
  RESPONDIO_API_TOKEN: "",
  RESPONDIO_API_BASE_URL: "",
  RESPONDIO_WEBHOOK_SIGNING_KEY: "",
  RESPONDIO_AGENT_USER_ID: "",
};

async function failsToStart(env: Record<string, string>, expected: string) {
  const app = await startApp(env, { waitReady: false });
  expect(await app.exited).toBe(1);
  expect(app.logs.join("\n")).toContain(expected);
}

test("§10 readiness: health reports ready integrations and nudge state", async () => {
  const { app } = await startHarness({ env: { NUDGE_ENABLED: "true" } });
  const response = await fetch(`${app.url}/health`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ready: true,
    channels: ["telegram"],
    damagedChats: 0,
    nudges: "ready",
  });
});

test("§10 configuration: a disabled channel needs no credentials, and respond.io can be replaced entirely", async () => {
  const { telegram } = await startHarness({ env: noRespondio });
  telegram.push(140, { text: "hi" });
  await until(() => telegram.sent().length === 1);
});

test("§10 configuration: invalid settings, unknown channels, and unknown models stop startup with an explanation", async () => {
  const { env } = await startHarness();
  await failsToStart({ ...env, DELIVERY_PACING: "fast" }, "DELIVERY_PACING");
  await failsToStart({ ...env, TIMEZONE: "Mars/Base" }, "TIMEZONE");
  await failsToStart(
    { ...env, NUDGE_MILESTONES: "5 minutes" },
    "NUDGE_MILESTONES",
  );
  await failsToStart(
    { ...env, CHANNELS: "whatsapp" },
    'unknown channel \\"whatsapp\\"',
  );
  await failsToStart(
    { ...env, AGENT_MODEL: "unknown/model" },
    "does not offer: unknown/model",
  );
  await failsToStart(
    { ...env, CHANNELS: "respondio", ...noRespondio },
    "RESPONDIO_API_TOKEN",
  );
});

test("§10 timezone: the configured timezone gives today's date", async () => {
  const { telegram, gateway } = await startHarness({
    env: { TIMEZONE: "Asia/Manila" },
  });
  telegram.push(141, { text: "hi" });
  await until(() => telegram.sent().length === 1);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
  }).format(new Date());
  expect(JSON.stringify(gateway.requests[0]?.messages[0])).toContain(
    `Today's date: ${today} (Asia/Manila)`,
  );
});

test("§10 shutdown: running work completes within the bound and the process exits cleanly", async () => {
  const { app, telegram, gateway } = await startHarness();
  gateway.script(() => ({
    text: "slow but complete answer",
    chunkDelayMs: 100,
  }));
  telegram.push(142, { text: "hi" });
  await until(() => gateway.requests.length === 1);
  expect(await app.stop()).toBe(0);
  expect(telegram.sent()).toEqual(["slow but complete answer"]);
});

test("§10 shutdown: work that exceeds the bound is stopped and preserved as unfinished", async () => {
  const { app, telegram, gateway, dataDir } = await startHarness({
    env: { SHUTDOWN_TIMEOUT_SECONDS: "0.3" },
  });
  gateway.script(() => ({
    text: "an answer that takes far too long to finish",
    chunkDelayMs: 300,
  }));
  telegram.push(143, { text: "hi" });
  await until(() => gateway.requests.length === 1);
  expect(await app.stop()).toBe(0);
  const turn = (await readChat(dataDir, "telegram", "143")).find(
    (e) => e.meta.type === "turn",
  );
  expect(turn?.meta.status).toBe("superseded");
  expect(String(turn?.meta.reason)).toBe("shutdown");
});

test("§10 logs: logs connect the work without message text or credentials", async () => {
  const { app, telegram, gateway } = await startHarness();
  gateway.script(() => ({ text: "Private answer text" }));
  telegram.push(144, { text: "my secret question" });
  await until(() => app.logs.some((l) => l.includes('"turn.ended"')));
  const logs = app.logs.join("\n");
  expect(logs).toContain('"conversation":"144"');
  expect(logs).toContain('"turn.ended"');
  for (const secret of [
    "my secret question",
    "Private answer text",
    "test-key",
    "123456:TEST",
  ])
    expect(logs).not.toContain(secret);
});
