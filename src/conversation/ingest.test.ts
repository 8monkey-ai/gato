import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ChannelConnection, InboundEvent } from "../channels/channel.ts";
import { createLogger } from "../log.ts";
import type { Author } from "../record/types.ts";
import { openChatStore } from "../storage/chat-store.ts";
import { createControls } from "./controls.ts";
import { createIngest } from "./ingest.ts";

let dataDir = "";
const ref = { connectionId: "rio", chatId: "42" };
const log = createLogger({}, () => {});
const now = () => new Date("2026-11-04T10:15:00.000Z");

const message = (
  eventId: string,
  platformId: string,
  author: Author,
  sentAt = "2026-11-04T10:10:00.000Z",
  text = "Hello",
): InboundEvent => ({
  kind: "message",
  chatId: "42",
  eventId,
  message: {
    platformId,
    author,
    sentAt: new Date(sentAt),
    text,
    attachments: [],
  },
});

async function setup(native = false) {
  const store = await openChatStore(dataDir, { timeZone: "UTC", log, now });
  const channel = {
    assignment: native
      ? {
          fetchState: () =>
            Promise.resolve({ owner: "none" as const, open: true }),
        }
      : undefined,
  } as ChannelConnection;
  const labels = { handoff: "h", outOfScope: "o", error: "e", expired: "x" };
  const controls = createControls({
    store,
    connection: () => channel,
    labels,
    log,
  });
  const customerTurns: string[] = [];
  const ownerChanges: string[] = [];
  const sink = createIngest({
    store,
    controls,
    log,
    now,
    onCustomerMessage: (r) => customerTurns.push(r.chatId),
    onOwnershipChange: (_r, previous, owner) =>
      ownerChanges.push(`${previous}->${owner}`),
  }).sinkFor("rio");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { store, sink, customerTurns, ownerChanges, settle };
}

async function agentPart(
  store: Awaited<ReturnType<typeof setup>>["store"],
  extra: {
    platformId?: string;
    delivery: "pending" | "uncertain";
    sentAt: string;
  },
) {
  await store.append(ref, [
    {
      type: "message",
      message: {
        id: "m1",
        author: { role: "agent" },
        text: "Hello",
        attachments: [],
        ...extra,
      },
    },
  ]);
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-ingest-"));
});
afterEach(() => fs.rm(dataDir, { recursive: true, force: true }));

test("repeated event ids and platform ids record one message and one turn request", async () => {
  const { store, sink, customerTurns, settle } = await setup();
  const first = message("e1", "p1", { role: "customer" });
  if (first.kind === "message")
    first.message.attachments = [
      { category: "image", source: "s1" },
      { category: "audio", source: "s2" },
    ];
  await sink(first);
  await sink(first);
  await sink(message("e2", "p1", { role: "customer" }));
  await settle();
  const view = await store.load(ref);
  expect(view.lastSeq).toBe(1);
  expect(view.messages[0]?.attachments.map((a) => a.id)).toEqual(["a1", "a2"]);
  expect(view.messages[0]?.delivery).toBe("observed");
  expect(customerTurns).toEqual(["42"]);
});

test("an agent echo with a known platform id confirms the original part", async () => {
  const { store, sink, customerTurns, settle } = await setup();
  await agentPart(store, {
    platformId: "p9",
    delivery: "uncertain",
    sentAt: "2026-11-04T10:00:00.000Z",
  });
  await sink(
    message("e1", "p9", { role: "agent" }, "2026-11-04T10:01:00.000Z"),
  );
  await settle();
  const view = await store.load(ref);
  expect(view.messages.map((m) => [m.id, m.delivery, m.sentAt])).toEqual([
    ["m1", "sent", "2026-11-04T10:01:00.000Z"],
  ]);
  expect(customerTurns).toEqual([]);
});

test("an agent echo with equal text reconciles to a recent unconfirmed part", async () => {
  const { store, sink } = await setup();
  await agentPart(store, {
    delivery: "pending",
    sentAt: "2026-11-04T10:08:00.000Z",
  });
  await sink(
    message("e1", "p10", { role: "agent" }, "2026-11-04T10:09:00.000Z"),
  );
  await sink(
    message(
      "e2",
      "p11",
      { role: "agent" },
      "2026-11-04T10:09:30.000Z",
      "Other",
    ),
  );
  const view = await store.load(ref);
  expect(
    view.messages.map((m) => [m.id === "m1", m.platformId, m.delivery]),
  ).toEqual([
    [true, "p10", "sent"],
    [false, "p11", "observed"],
  ]);
});

test("an echo does not match an unconfirmed part older than ten minutes", async () => {
  const { store, sink } = await setup();
  await agentPart(store, {
    delivery: "uncertain",
    sentAt: "2026-11-04T10:04:00.000Z",
  });
  await sink(message("e1", "p10", { role: "agent" }));
  const view = await store.load(ref);
  expect(view.messages.map((m) => m.delivery)).toEqual([
    "uncertain",
    "observed",
  ]);
});

test("outgoing operator and workflow messages never request a turn", async () => {
  const { store, sink, customerTurns, settle } = await setup();
  await sink(message("e1", "p1", { role: "operator", name: "Ana" }));
  await sink(message("e2", "p2", { role: "workflow" }));
  await settle();
  expect((await store.load(ref)).messages.length).toBe(2);
  expect(customerTurns).toEqual([]);
});

test("a delayed message takes its original place without moving latest activity back", async () => {
  const { store, sink } = await setup();
  await sink(
    message(
      "e1",
      "p1",
      { role: "customer" },
      "2026-11-04T10:10:00.000Z",
      "second",
    ),
  );
  await sink(
    message(
      "e2",
      "p2",
      { role: "customer" },
      "2026-11-04T10:05:00.000Z",
      "first",
    ),
  );
  const view = await store.load(ref);
  expect(view.messages.map((m) => m.text)).toEqual(["first", "second"]);
  expect(view.latestCustomerAt).toBe("2026-11-04T10:10:00.000Z");
});

test("an older ownership event is recorded but does not change the owner", async () => {
  const { store, sink, ownerChanges, settle } = await setup(true);
  const ownership = (
    eventId: string,
    owner: "agent" | "human",
    at: string,
  ): InboundEvent => ({
    kind: "ownership",
    chatId: "42",
    eventId,
    at: new Date(at),
    owner,
  });
  await sink(ownership("e1", "agent", "2026-11-04T10:10:00.000Z"));
  await sink(ownership("e2", "human", "2026-11-04T10:05:00.000Z"));
  await settle();
  const view = await store.load(ref);
  expect(view.lastSeq).toBe(2);
  expect(view.ownership?.owner).toBe("agent");
  expect(ownerChanges).toEqual(["none->agent"]);
});
