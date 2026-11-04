import { afterEach, beforeEach, spyOn } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import { createAttachmentRetrieval } from "../attachments/retrieve.ts";
import type { ChannelConnection, OutboundPart } from "../channels/channel.ts";
import { createEnvReader } from "../config/env.ts";
import { readSettings } from "../config/settings.ts";
import { createControls } from "../conversation/controls.ts";
import { createDelivery } from "../delivery/deliver.ts";
import { createLogger } from "../log.ts";
import type { Entry, EntryBody } from "../record/types.ts";
import { type ChatStore, openChatStore } from "../storage/chat-store.ts";
import { createTurnRunner } from "./turn.ts";

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
export type Chunk =
  StreamResult["stream"] extends ReadableStream<infer T> ? T : never;

export const ref = { connectionId: "tg", chatId: "42" };
const now = () => new Date("2026-11-04T10:15:00.000Z");
let logLines: string[] = [];
const log = createLogger({}, (line) => logLines.push(line));
const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
let dataDir = "";
let skillsDir = "";
let store: ChatStore;

export const dirs = () => ({ dataDir, skillsDir });

// Registers the hooks that give each test a fresh data folder and skills checkout.
export function useTurnFixture() {
  beforeEach(async () => {
    logLines = [];
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-turn-data-"));
    skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-turn-skills-"));
    await Bun.write(path.join(skillsDir, "AGENTS.md"), "Be kind.\n");
    await Bun.write(
      path.join(skillsDir, "skills/refunds/SKILL.md"),
      "---\nname: refunds\ndescription: Refund rules.\n---\nRefunds take 5 days.\n",
    );
    store = await openChatStore(dataDir, { timeZone: "UTC", log, now });
    await store.append(ref, [
      {
        type: "message",
        eventId: "e1",
        message: {
          id: "m1",
          author: { role: "customer" },
          sentAt: "2026-11-04T10:14:00.000Z",
          text: "Hello",
          attachments: [],
          delivery: "observed",
        },
      },
    ]);
  });
  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(skillsDir, { recursive: true, force: true });
  });
}

export const stream = (chunks: Chunk[]): StreamResult => ({
  stream: simulateReadableStream({ chunks }),
});
export const finish = (unified: "stop" | "tool-calls"): Chunk => ({
  type: "finish",
  finishReason: { unified, raw: undefined },
  usage,
});
export const textStep = (...deltas: string[]) =>
  stream([
    { type: "text-start", id: "t" },
    ...deltas.map((delta): Chunk => ({ type: "text-delta", id: "t", delta })),
    { type: "text-end", id: "t" },
    finish("stop"),
  ]);
export const toolStep = (toolName: string, input: unknown, toolCallId = "c1") =>
  stream([
    { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
    finish("tool-calls"),
  ]);

const settingsFor = (env: Record<string, string>) =>
  readSettings(
    createEnvReader({
      GATO_DATA_DIR: dataDir,
      GATO_SKILLS_DIR: skillsDir,
      GATO_COUNTRY: "PH",
      OPENROUTER_API_KEY: "k",
      GATO_MODEL: "base/model",
      GATO_CONNECTIONS: "tg",
      GATO_CONNECTION_TG_TYPE: "telegram",
      GATO_DELIVERY_PACING: "none",
      ...env,
    }),
  );

function fakeConnection(extra: Partial<ChannelConnection>) {
  const sent: OutboundPart[] = [];
  const onSend: (() => void)[] = [];
  const connection: ChannelConnection = {
    id: "tg",
    maxTextLength: 4096,
    supportsVideo: false,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    send: (_chatId, part) => {
      sent.push(part);
      onSend.shift()?.();
      return Promise.resolve({ status: "sent", sentAt: now() });
    },
    fetchAttachment: () => Promise.reject(new Error("no file")),
    ...extra,
  };
  const texts = () => sent.map((p) => (p.kind === "text" ? p.text : p.url));
  return { connection, texts, onSend };
}

export function setup(
  doStream: NonNullable<
    ConstructorParameters<typeof MockLanguageModelV4>[0]
  >["doStream"],
  env: Record<string, string> = {},
  connectionExtra: Partial<ChannelConnection> = {},
) {
  const settings = settingsFor(env);
  const { connection, texts, onSend } = fakeConnection(connectionExtra);
  const model = new MockLanguageModelV4({ doStream });
  const controls = createControls({
    store,
    connection: () => connection,
    labels: settings.labels,
    log,
  });
  const runTurn = createTurnRunner({
    store,
    controls,
    connection: () => connection,
    provider: () => model,
    settings,
    skillsDir,
    summaryPrompt: "Summarise.",
    retrieveAttachments: createAttachmentRetrieval(),
    mcpTools: [],
    delivery: createDelivery({ store, settings: settings.delivery, log, now }),
    log,
    now,
  });
  return { runTurn, model, texts, onSend };
}

export const signal = () => new AbortController().signal;

export async function entries<T extends Entry["type"]>(...types: T[]) {
  const file = path.join(dataDir, "tg/42/events.jsonl");
  return (await fs.readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Entry)
    .filter((e): e is Extract<Entry, { type: T }> =>
      (types as string[]).includes(e.type),
    );
}

export const turnEnd = async () =>
  (await entries("turn-end")).map((e) => [e.outcome, e.reason]);
export const handoffs = async () =>
  (await entries("handoff")).map((e) => [e.path, e.reason]);
export const labels = async () =>
  (await entries("labels")).map((e) => e.labels);

export const logged = () =>
  logLines.map((line) => JSON.parse(line) as Record<string, unknown>);

// Makes every store append that contains a matching entry fail, for all users of the store.
export function failAppends(match: (body: EntryBody) => boolean) {
  const append = store.append.bind(store);
  spyOn(store, "append").mockImplementation((r, bodies) =>
    bodies.some(match)
      ? Promise.reject(new Error("disk full"))
      : append(r, bodies),
  );
}
