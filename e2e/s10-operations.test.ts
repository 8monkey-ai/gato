import { afterEach, expect, test } from "bun:test";

import { readChat, startApp, waitUntil } from "./support/app.ts";
import { systemText } from "./support/fake-openrouter.ts";
import { messageEvent, notify } from "./support/fake-respondio.ts";
import { createWorld, type World } from "./support/world.ts";

let world: World;
afterEach(async () => world.close());

test("§10 readiness is visible with connections and nudge state", async () => {
  world = await createWorld();
  const app = await world.start({ NUDGES_ENABLED: "true" }, "both");
  const health = await waitUntil(async () => {
    const body = (await (await fetch(`${app.url}/health`)).json()) as Record<
      string,
      unknown
    >;
    return body.nudges === "ready" && body;
  });
  expect(health).toEqual({
    ready: true,
    connections: [world.telegram.connectionId, "respondio-main"],
    damagedConversations: 0,
    nudges: "ready",
  });
});

test("§10 a deployment without any channel, an unreachable gateway, or an unknown timezone does not start", async () => {
  world = await createWorld();
  const cases = [
    [{}, "No channel is enabled"],
    [
      {
        ...world.telegramEnv,
        OPENROUTER_BASE_URL: "http://127.0.0.1:9/api/v1",
      },
      "127.0.0.1:9",
    ],
    [{ ...world.telegramEnv, AGENT_TIMEZONE: "Mars/Base" }, "AGENT_TIMEZONE"],
  ] as const;
  for (const [env, error] of cases) {
    const app = await startApp({ ...world.baseEnv, ...env });
    expect([app.started, app.startError.includes(error)]).toEqual([
      false,
      true,
    ]);
  }
});

test("§10 a model that the gateway does not list is reported and the harness still starts", async () => {
  world = await createWorld();
  const app = await world.start({
    AGENT_MODEL: "team/agent-alias",
    SUMMARY_MODEL: "team/agent-alias",
  });
  expect(app.started).toBe(true);
  const warning = await app.waitForLog("models.not_listed");
  expect(warning.models).toEqual(["team/agent-alias"]);
});

test("§10 the configured timezone sets today's date", async () => {
  world = await createWorld();
  await world.start({ AGENT_TIMEZONE: "Pacific/Kiritimati" });
  world.telegram.push(42, { text: "Hi" });
  await waitUntil(() => world.telegram.sent.length);
  const today = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Pacific/Kiritimati",
    dateStyle: "full",
  }).format();
  expect(systemText(world.llm.mainRequests()[0]!)).toContain(
    `Today is ${today} (timezone Pacific/Kiritimati).`,
  );
});

test("§10 logs connect the work without credentials or message text", async () => {
  world = await createWorld();
  world.llm.respond(() => ({ status: 401 }));
  const app = await world.start({}, "both");
  world.telegram.push(42, { text: "My secret address is 1 Main St" });
  await notify(
    app.url,
    "main",
    messageEvent({ contact: 5, traffic: "incoming", text: "x" }),
    world.respondio.signingKey,
  );
  await app.waitForLog("turn.ended", (l) => l.contact === "42");
  await app.waitForLog("turn.ended", (l) => l.contact === "5");

  const output = app.output.join("\n");
  for (const secret of [
    world.telegram.token,
    "test-openrouter-key",
    "test-respondio-token",
    "1 Main St",
  ]) {
    expect(output).not.toContain(secret);
  }
  expect(
    app.logs.filter((l) => l.contact === "42").map((l) => l.event),
  ).toContain("message.recorded");
});

test("§10 shutdown lets a running turn finish within the bound and refuses new work", async () => {
  world = await createWorld();
  world.llm.respond(() => ({ text: "Done in time.", hangMs: 600 }));
  const app = await world.start({}, "respondio");
  await notify(
    app.url,
    "main",
    messageEvent({ contact: 5, traffic: "incoming", text: "Hi" }),
    world.respondio.signingKey,
  );
  await waitUntil(() => world.llm.requests.length);
  app.proc.kill("SIGTERM");
  await Bun.sleep(100);

  const late = await notify(
    app.url,
    "main",
    messageEvent({ contact: 5, traffic: "incoming", text: "Late" }),
    world.respondio.signingKey,
  );
  expect(late.status).toBe(503);
  expect(await app.proc.exited).toBe(0);
  expect(world.respondio.sent.map((s) => s.message.text)).toEqual([
    "Done in time.",
  ]);
});

test("§10 work that passes the shutdown bound stops and stays recorded", async () => {
  world = await createWorld();
  world.llm.respond(() => ({ text: "Never sent.", hangMs: 5000 }));
  const app = await world.start({ SHUTDOWN_TIMEOUT_SECONDS: "0.3" });
  world.telegram.push(42, { text: "Hi" });
  await waitUntil(() => world.llm.requests.length);
  const stoppedAt = Date.now();
  await app.stop();

  expect(Date.now() - stoppedAt).toBeLessThan(2000);
  const chat = await readChat(world.dataDir, world.telegram.connectionId, "42");
  expect(chat.map((e) => [e.tag, e.meta.outcome])).toEqual([
    ["customer", undefined],
    ["turn", "superseded"],
  ]);
});

test("§10 each model call tells the gateway its call type and contact", async () => {
  world = await createWorld();
  world.telegram.files.set("p", new Uint8Array([1, 2, 3]));
  await world.start({
    IMAGE_PREPARATION_MODEL: "test/vision",
    NUDGES_ENABLED: "true",
    NUDGES_CHECK_INTERVAL_SECONDS: "0.2",
    NUDGES_MILESTONES_MINUTES: "0.02",
  });
  world.telegram.push(42, {
    photo: [{ file_id: "p", file_unique_id: "p", width: 1, height: 1 }],
  });
  await waitUntil(() => world.telegram.sent.length === 2, 4000);

  expect(world.llm.requests.map((r) => r.metadata)).toEqual([
    { call_type: "preparation", contact_id: "42" },
    { call_type: "message", contact_id: "42" },
    { call_type: "nudge", contact_id: "42" },
  ]);
});
