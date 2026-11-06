import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IncomingMessage } from "../channels/channel.ts";
import { ChatStore } from "../record/store.ts";
import { recordIncoming } from "./incoming.ts";

const message = (extra: Partial<IncomingMessage>): IncomingMessage => ({
  ref: "r1",
  at: new Date("2026-01-01T00:00:00Z"),
  role: "customer",
  text: "hi",
  attachments: [],
  answerable: true,
  ...extra,
});

test("a message is stored once, and only answerable customer input triggers", async () => {
  const store = await ChatStore.open(await mkdtemp(join(tmpdir(), "data-")));
  const chat = store.chat("telegram", "1");
  expect(await recordIncoming(chat, message({}))).toBe(true);
  expect(await recordIncoming(chat, message({}))).toBe(false);
  expect(
    await recordIncoming(chat, message({ ref: "r2", role: "operator" })),
  ).toBe(false);
  expect(
    chat.entries.map(
      (e) => e.type === "message" && [e.role, e.trigger ?? false],
    ),
  ).toEqual([
    ["customer", true],
    ["operator", false],
  ]);
});

test("an echo of an agent send updates the original record", async () => {
  const store = await ChatStore.open(await mkdtemp(join(tmpdir(), "data-")));
  const chat = store.chat("respondio", "1");
  await chat.add({
    type: "message",
    at: "2026-01-01T00:00:00.000Z",
    role: "agent",
    text: "Hello",
    delivery: "uncertain",
  });
  await recordIncoming(
    chat,
    message({ ref: "55", role: "agent", text: "Hello" }),
  );
  expect(chat.entries).toMatchObject([
    { role: "agent", delivery: "sent", ref: "55" },
  ]);
});
