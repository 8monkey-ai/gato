import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MockLanguageModelV4 } from "ai/test";

import { createBudget } from "../agent/budget.ts";
import { createLogger } from "../log.ts";
import { openChatStore } from "../storage/chat-store.ts";
import { PreparationError, prepareAttachments } from "./prepare.ts";

let dataDir = "";
const log = createLogger({}, () => {});
const ref = { connectionId: "tg", chatId: "42" };
const now = () => new Date("2026-11-04T10:20:00.000Z");
const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const reply = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage,
  warnings: [],
});

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-prepare-"));
});
afterEach(() => fs.rm(dataDir, { recursive: true, force: true }));

async function storeWithVoiceNote() {
  const store = await openChatStore(dataDir, { timeZone: "UTC", log, now });
  const file = await store.saveAttachment(
    ref,
    "m1-a1.ogg",
    new Uint8Array([7]),
  );
  await store.append(ref, [
    {
      type: "message",
      message: {
        id: "m1",
        author: { role: "customer" },
        sentAt: "2026-11-04T10:15:00.000Z",
        text: "listen",
        attachments: [
          {
            id: "a1",
            category: "audio",
            source: "s1",
            mediaType: "audio/ogg",
            file,
          },
          { id: "a2", category: "image", source: "s2", file },
        ],
        delivery: "observed",
      },
    },
  ]);
  return store;
}

async function run(
  store: Awaited<ReturnType<typeof storeWithVoiceNote>>,
  model: MockLanguageModelV4,
) {
  const budget = createBudget({ timeoutMs: 60_000, maxModelCalls: 5 });
  await prepareAttachments({
    store,
    ref,
    messages: (await store.load(ref)).messages,
    models: { audio: "transcriber" },
    provider: () => model,
    budget,
    log,
    now,
  }).finally(budget.dispose);
  return budget;
}

test("saves the transcript and reuses it without a second model call", async () => {
  const store = await storeWithVoiceNote();
  const model = new MockLanguageModelV4({
    doGenerate: reply(" I need a refund "),
  });
  expect((await run(store, model)).remainingCalls()).toBe(4);
  expect((await run(store, model)).remainingCalls()).toBe(5);

  expect(model.doGenerateCalls.length).toBe(1);
  expect(model.doGenerateCalls[0]?.prompt).toMatchObject([
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Transcribe this audio. Return only the transcript.",
        },
        { type: "file", mediaType: "audio/ogg" },
      ],
    },
  ]);
  const [message] = (await store.load(ref)).messages;
  expect(message?.attachments.map((a) => a.preparation)).toEqual([
    {
      model: "transcriber",
      at: "2026-11-04T10:20:00.000Z",
      text: "I need a refund",
    },
    undefined,
  ]);
  expect(message?.text).toBe("listen");
});

test("an empty response is a recorded processing failure", async () => {
  const store = await storeWithVoiceNote();
  const model = new MockLanguageModelV4({ doGenerate: reply("  ") });
  await expect(run(store, model)).rejects.toThrow(PreparationError);

  const [message] = (await store.load(ref)).messages;
  expect(message?.attachments[0]?.preparation).toEqual({
    model: "transcriber",
    at: "2026-11-04T10:20:00.000Z",
    error: "The model returned no text",
  });
});
