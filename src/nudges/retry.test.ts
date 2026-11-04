import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ChannelConnection } from "../channels/channel.ts";
import { createControls } from "../conversation/controls.ts";
import { createLogger } from "../log.ts";
import type { ChatRef, EntryBody } from "../record/types.ts";
import { openChatStore } from "../storage/chat-store.ts";
import { failedNudges, retryFailedNudges } from "./retry.ts";

const T = Date.parse("2026-11-04T10:00:00.000Z");
const minute = 60_000;
const log = createLogger({}, () => {});
let dataDir = "";
let clock = new Date(T);
const chat = (chatId: string) => ({ connectionId: "tg", chatId });

const customer = (id: string, offsetMinutes: number): EntryBody => ({
  type: "message",
  message: {
    id,
    author: { role: "customer" },
    sentAt: new Date(T + offsetMinutes * minute).toISOString(),
    attachments: [],
    delivery: "observed",
  },
});
const nudgeNote: EntryBody = {
  type: "note",
  by: "agent",
  kind: "nudge",
  text: "Nudge",
};
const failureNote: EntryBody = {
  type: "note",
  by: "system",
  kind: "nudge-failed",
  text: "Nudge failed: failed",
};

async function setup() {
  const store = await openChatStore(dataDir, {
    timeZone: "UTC",
    log,
    now: () => clock,
  });
  const record = async (ref: ChatRef, offsetMinutes: number, e: EntryBody) => {
    clock = new Date(T + offsetMinutes * minute);
    await store.append(ref, [e]);
  };
  const controls = createControls({
    store,
    connection: () => ({}) as ChannelConnection,
    labels: { handoff: "h", outOfScope: "o", error: "e", expired: "x" },
    log,
  });
  return {
    store,
    record,
    deps: { store, controls, policy: "assigned" as const },
  };
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-retry-"));
});
afterEach(() => fs.rm(dataDir, { recursive: true, force: true }));

async function seedFailure(
  record: (ref: ChatRef, offset: number, e: EntryBody) => Promise<void>,
  ref: ChatRef,
  offset = 35,
) {
  await record(ref, 0, customer(`c-${ref.chatId}`, 0));
  await record(ref, offset, nudgeNote);
  await record(ref, offset + 1, failureNote);
}

test("a failure note alone keeps a retry eligible and a later customer message does not", async () => {
  const { record, deps } = await setup();
  await seedFailure(record, chat("a"));
  await seedFailure(record, chat("b"));
  await record(chat("b"), 40, customer("c2", 40));
  await seedFailure(record, chat("old"), -60);
  const found = await failedNudges(deps, new Date(T));
  expect(
    found.map((f) => [
      f.ref.chatId,
      f.attemptAt.toISOString(),
      f.reason,
      f.eligible,
    ]),
  ).toEqual([
    ["a", "2026-11-04T10:35:00.000Z", "Nudge failed: failed", true],
    ["b", "2026-11-04T10:35:00.000Z", "Nudge failed: failed", false],
  ]);
});

test("retries run eligible chats, record new failures and isolate errors", async () => {
  const { store, record, deps } = await setup();
  await seedFailure(record, chat("a"));
  await seedFailure(record, chat("d"));
  const triggers: string[] = [];
  const scheduler = {
    runExclusive: (ref: ChatRef, trigger: string) => {
      triggers.push(trigger);
      return ref.chatId === "d"
        ? Promise.reject(new Error("boom"))
        : Promise.resolve("failed" as const);
    },
  };
  const results = await retryFailedNudges(
    { ...deps, scheduler, log },
    new Date(T),
  );
  expect(results.map((r) => [r.ref.chatId, r.outcome])).toEqual([
    ["a", "failed"],
    ["d", "error"],
  ]);
  expect(triggers).toEqual(["nudge-retry", "nudge-retry"]);
  const kinds = (await store.load(chat("a"))).notes.map((n) => n.kind);
  expect(kinds).toEqual(["nudge", "nudge-failed", "nudge-failed"]);
});

test("a paused chat is not eligible for a retry under any policy", async () => {
  const { store, record, deps } = await setup();
  await seedFailure(record, chat("p"));
  await store.writeTextFile(chat("p"), "paused", "Ana handles this\n");
  const unrestricted = { ...deps, policy: "unrestricted" as const };
  const found = await failedNudges(unrestricted, new Date(T));
  expect(found.map((f) => [f.ref.chatId, f.eligible])).toEqual([["p", false]]);
});
