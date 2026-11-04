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
let logLines: string[] = [];
const log = createLogger({}, (line) => logLines.push(line));
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
  const retrievals: string[] = [];
  const sink = createIngest({
    store,
    controls,
    log,
    now,
    onCustomerMessage: (r) => customerTurns.push(r.chatId),
    onNewAttachments: (r) => {
      retrievals.push(r.chatId);
      return Promise.reject(new Error("download failed"));
    },
    onStateChange: (_r, previous, current) =>
      ownerChanges.push(
        `${previous.owner}/${previous.open}->${current.owner}/${current.open}`,
      ),
  }).sinkFor("rio");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { store, sink, customerTurns, ownerChanges, retrievals, settle };
}

async function agentPart(
  store: Awaited<ReturnType<typeof setup>>["store"],
  extra: {
    platformId?: string;
    delivery: "pending" | "uncertain";
    sentAt: string;
  },
  id = "m1",
) {
  await store.append(ref, [
    {
      type: "message",
      message: {
        id,
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
  logLines = [];
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
  expect(ownerChanges).toEqual(["none/true->agent/true"]);
});

test("a new message with attachments requests retrieval without waiting for it", async () => {
  const { sink, customerTurns, retrievals, settle } = await setup();
  const withFile = (event: InboundEvent) => {
    if (event.kind === "message")
      event.message.attachments = [{ category: "image", source: "s1" }];
    return event;
  };
  await sink(withFile(message("e1", "p1", { role: "operator" })));
  await sink(withFile(message("e1", "p1", { role: "operator" })));
  await sink(message("e2", "p2", { role: "customer" }));
  await sink(withFile(message("e3", "p3", { role: "customer" })));
  await settle();
  expect(retrievals).toEqual(["42", "42"]);
  expect(customerTurns).toEqual(["42", "42"]);
});

test("an echo prefers a pending part, then the newest part with equal text", async () => {
  const { store, sink } = await setup();
  const at = (minute: string) => `2026-11-04T10:${minute}:00.000Z`;
  await agentPart(store, { delivery: "uncertain", sentAt: at("09") }, "u1");
  await agentPart(store, { delivery: "pending", sentAt: at("06") }, "p1");
  await agentPart(store, { delivery: "pending", sentAt: at("07") }, "p2");
  const echo = (eventId: string, platformId: string) =>
    sink(message(eventId, platformId, { role: "agent" }, at("10")));
  await echo("e1", "x1");
  await echo("e2", "x2");
  await echo("e3", "x3");
  const view = await store.load(ref);
  expect(view.messages.map((m) => [m.id, m.platformId])).toEqual([
    ["u1", "x3"],
    ["p1", "x2"],
    ["p2", "x1"],
  ]);
});

test("reopening a chat reports the state change", async () => {
  const { sink, ownerChanges, settle } = await setup(true);
  const status = (eventId: string, open: boolean): InboundEvent => ({
    kind: "status",
    chatId: "42",
    eventId,
    at: new Date(`2026-11-04T10:0${eventId.slice(1)}:00.000Z`),
    open,
  });
  await sink(status("e1", false));
  await sink(status("e2", true));
  await settle();
  expect(ownerChanges).toEqual([
    "none/true->none/false",
    "none/false->none/true",
  ]);
});

test("each new message is logged without its text", async () => {
  const { sink } = await setup();
  await sink(message("e1", "p1", { role: "customer" }));
  await sink(message("e1", "p1", { role: "customer" }));
  const accepted = logLines.filter((l) => l.includes('"message.accepted"'));
  expect(accepted.length).toBe(1);
  expect(JSON.parse(accepted[0] ?? "{}")).toMatchObject({
    level: "info",
    connectionId: "rio",
    chatId: "42",
    messageId: expect.any(String) as unknown,
    platformId: "p1",
    eventId: "e1",
    role: "customer",
  });
  expect(logLines.join("")).not.toContain("Hello");
});
