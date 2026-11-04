import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MockLanguageModelV4 } from "ai/test";

import { textStep } from "./agent/turn-fixture.ts";
import { createApp } from "./app.ts";
import type {
  ChannelConnection,
  InboundEvent,
  InboundSink,
  OutboundPart,
} from "./channels/channel.ts";
import { registerChannelType } from "./channels/registry.ts";
import { createLogger } from "./log.ts";

let dataDir = "";
let skillsDir = "";
let sink: InboundSink | undefined;
let sent: OutboundPart[] = [];
const log = createLogger({}, () => {});
const now = () => new Date("2026-11-04T10:15:00.000Z");

registerChannelType({
  type: "fake-e2e",
  create: (id): Promise<ChannelConnection> =>
    Promise.resolve({
      id,
      maxTextLength: 4096,
      supportsVideo: false,
      start: (inbound) => {
        sink = inbound;
        return Promise.resolve();
      },
      stop: () => Promise.resolve(),
      send: (_chatId, part) => {
        sent.push(part);
        return Promise.resolve({ status: "sent", sentAt: now() });
      },
      fetchAttachment: () => Promise.reject(new Error("no file")),
    }),
});

const env = () => ({
  GATO_DATA_DIR: dataDir,
  GATO_SKILLS_DIR: skillsDir,
  GATO_COUNTRY: "PH",
  OPENROUTER_API_KEY: "k",
  GATO_MODEL: "base/model",
  GATO_CONNECTIONS: "fake",
  GATO_CONNECTION_FAKE_TYPE: "fake-e2e",
  GATO_NUDGES_ENABLED: "false",
  GATO_DELIVERY_PACING: "none",
  GATO_SHUTDOWN_GRACE: "5s",
});

const message = (
  eventId: string,
  role: "customer" | "operator",
  text: string,
): InboundEvent => ({
  kind: "message",
  chatId: "42",
  eventId,
  message: {
    platformId: eventId,
    author: role === "customer" ? { role } : { role, name: "Ana" },
    sentAt: new Date("2026-11-04T10:14:00.000Z"),
    text,
    attachments: [],
  },
});

async function startApp() {
  const model = new MockLanguageModelV4({
    doStream: () =>
      Promise.resolve(textStep("Hello there.\n\n", "How can I help you?")),
  });
  const app = await createApp({ env: env(), provider: () => model, now, log });
  await app.start();
  return { app, model };
}

const chatText = () =>
  fs.readFile(path.join(dataDir, "fake/42/chat.txt"), "utf8");

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-app-data-"));
  skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-app-skills-"));
  await Bun.write(path.join(skillsDir, "AGENTS.md"), "Be kind.\n");
  sink = undefined;
  sent = [];
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(skillsDir, { recursive: true, force: true });
});

test("a customer message gets a reply in two parts, recorded in chat.txt", async () => {
  const { app, model } = await startApp();
  await sink?.(message("e1", "customer", "Hi"));
  await app.stop();
  expect(model.doStreamCalls.length).toBe(1);
  expect(sent).toEqual([
    { kind: "text", text: "Hello there" },
    { kind: "text", text: "How can I help you?" },
  ]);
  expect(await chatText()).toBe(
    "[2026-11-04 10:14:00 UTC] Customer: Hi\n" +
      "[2026-11-04 10:15:00 UTC] Agent: Hello there\n" +
      "[2026-11-04 10:15:00 UTC] Agent: How can I help you?\n",
  );
});

test("an outgoing operator message is recorded and gets no reply", async () => {
  const { app, model } = await startApp();
  await sink?.(message("e1", "operator", "I will check."));
  await app.stop();
  expect(model.doStreamCalls.length).toBe(0);
  expect(sent).toEqual([]);
  expect(await chatText()).toContain("I will check.");
});

test("health reports readiness while the app runs", async () => {
  const { app } = await startApp();
  const response = await app.fetch(new Request("http://gato/health"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ready: true,
    storage: "writable",
    damagedChats: 0,
    connections: [{ id: "fake", started: true }],
    mcpServers: [],
    models: "not checked",
    nudges: { reconciledChats: 0, unreconciledChats: 0 },
  });
  expect((await app.fetch(new Request("http://gato/unknown"))).status).toBe(
    404,
  );
  await app.stop();
  expect((await app.fetch(new Request("http://gato/health"))).status).toBe(503);
});

test("a configuration error names every bad variable", async () => {
  const error = await createApp({
    env: {
      GATO_DATA_DIR: dataDir,
      PORT: "abc",
      GATO_CONNECTIONS: "fake",
      GATO_CONNECTION_FAKE_TYPE: "nope",
    },
    log,
  }).then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  expect(error?.name).toBe("ConfigError");
  for (const problem of [
    'PORT: "abc" is not valid; accepted: a positive integer',
    "GATO_COUNTRY: required; accepted: MY, PH",
    "GATO_SKILLS_DIR: required",
    'GATO_CONNECTION_FAKE_TYPE: "nope" is not valid; accepted: ',
  ])
    expect(error?.message).toContain(problem);
  expect(error?.message).toContain("fake-e2e");
});

test("a second app on the same data folder fails because of the lock", async () => {
  const { app } = await startApp();
  await expect(
    createApp({ env: env(), provider: () => new MockLanguageModelV4(), log }),
  ).rejects.toThrow(`Data folder ${dataDir} is in use by process`);
  await app.stop();
});
