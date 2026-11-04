import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MockLanguageModelV4 } from "ai/test";

import { BudgetExceededError, createBudget } from "../agent/budget.ts";
import { createLogger } from "../log.ts";
import { project } from "../record/projection.ts";
import type { Author, Delivery, EntryBody } from "../record/types.ts";
import { openChatStore } from "../storage/chat-store.ts";
import { ensureSummary } from "./generate.ts";

let dataDir = "";
const log = createLogger({}, () => {});
const ref = { connectionId: "tg", chatId: "42" };
const now = new Date("2026-11-08T12:00:00.000Z");
const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const reply = (text: string) =>
  new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    },
  });

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-summary-"));
});
afterEach(() => fs.rm(dataDir, { recursive: true, force: true }));

const message = (
  id: string,
  author: Author,
  sentAt: string,
  delivery: Delivery = "observed",
  extra: Partial<Extract<EntryBody, { type: "message" }>["message"]> = {},
): EntryBody => ({
  type: "message",
  message: {
    id,
    author,
    sentAt,
    text: id,
    attachments: [],
    delivery,
    ...extra,
  },
});

const bodies: EntryBody[] = [
  message(
    "Need help",
    { role: "customer" },
    "2026-11-04T10:15:00.000Z",
    "observed",
    {
      attachments: [
        {
          id: "a1",
          category: "audio",
          source: "s",
          fileName: "v.ogg",
          preparation: {
            model: "t",
            at: "2026-11-04T10:16:00.000Z",
            text: "my order",
          },
        },
        { id: "a2", category: "image", source: "s", fileName: "p.jpg" },
      ],
    },
  ),
  message("Welcome", { role: "workflow" }, "2026-11-04T10:16:00.000Z"),
  message("Draft", { role: "agent" }, "2026-11-04T10:17:00.000Z", "superseded"),
  message("Sure", { role: "agent" }, "2026-11-04T10:18:00.000Z", "sent"),
  message(
    "Done",
    { role: "operator", name: "Ana" },
    "2026-11-05T09:00:00.000Z",
  ),
  { type: "note", by: "system", kind: "info", text: "private" },
  { type: "trigger", turnId: "t1", text: "Nudge" },
];
const view = project(
  bodies.map((body, i) => ({
    ...body,
    seq: i + 1,
    at: "2026-11-05T09:00:00.000Z",
  })),
);

async function run(model: MockLanguageModelV4, maxModelCalls = 5) {
  const store = await openChatStore(dataDir, { timeZone: "UTC", log });
  const budget = createBudget({ timeoutMs: 60_000, maxModelCalls });
  try {
    return await ensureSummary({
      store,
      ref,
      view,
      now,
      timeZone: "Asia/Kuala_Lumpur",
      modelId: "m",
      provider: () => model,
      prompt: "Summarise",
      budget,
      log,
    });
  } finally {
    budget.dispose();
  }
}

const summaryFile = () =>
  fs.readFile(path.join(dataDir, "tg/42/summary.txt"), "utf8");
const saveSummary = async (generatedAt: string) => {
  await fs.mkdir(path.join(dataDir, "tg/42"), { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "tg/42/summary.txt"),
    `Generated: ${generatedAt}\n\nOld notes`,
  );
};

test("reuses a summary younger than three days without a model call", async () => {
  await saveSummary("2026-11-06T12:00:00.000Z");
  const model = reply("New notes");
  expect(await run(model)).toBe("Old notes");
  expect(model.doGenerateCalls.length).toBe(0);
});

test("generates from dated visible content and saves the result", async () => {
  const model = reply(" New notes ");
  expect(await run(model)).toBe("New notes");
  expect(model.doGenerateCalls[0]?.prompt).toEqual([
    { role: "system", content: "Summarise" },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "[2026-11-04 18:15] Customer: Need help [audio transcript v.ogg: my order] [image attachment p.jpg]",
            "[2026-11-04 18:18] Agent: Sure",
            "[2026-11-05 17:00] Human colleague: Done",
          ].join("\n"),
        },
      ],
    },
  ]);
  expect(await summaryFile()).toBe(
    "Generated: 2026-11-08T12:00:00.000Z\n\nNew notes",
  );
});

test("an empty refresh keeps the previous summary", async () => {
  await saveSummary("2026-11-01T12:00:00.000Z");
  expect(await run(reply("   "))).toBe("Old notes");
  expect(await summaryFile()).toBe(
    "Generated: 2026-11-01T12:00:00.000Z\n\nOld notes",
  );
});

test("a failed refresh proceeds without a summary and keeps the saved one", async () => {
  await saveSummary("2026-11-01T12:00:00.000Z");
  const model = new MockLanguageModelV4({
    doGenerate: () => Promise.reject(new Error("rate limited")),
  });
  expect(await run(model)).toBeUndefined();
  expect(await summaryFile()).toBe(
    "Generated: 2026-11-01T12:00:00.000Z\n\nOld notes",
  );
});

test("an exhausted call budget is not a summary failure", async () => {
  await expect(run(reply("New notes"), 0)).rejects.toThrow(BudgetExceededError);
});
