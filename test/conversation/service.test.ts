import { expect, test } from "bun:test";

import type { InboundEvent } from "../../src/channel/inbound.ts";
import { inboundService } from "../../src/conversation/service.ts";
import { tmpDataDir } from "../support/data-dir.ts";
import { capturingLogger, chat, openTestStore, t0 } from "../support/store.ts";

function inbound(
  role: "customer" | "operator" | "agent",
  dedupKey: string,
  externalId?: string,
): InboundEvent {
  return {
    type: "message",
    chatKey: "42",
    dedupKey,
    at: t0,
    role,
    sender: { id: "u1", name: "Ali", known: true },
    parts: [{ kind: "text", text: "Hello" }],
    externalId,
  };
}

async function setup() {
  const store = await openTestStore(await tmpDataDir());
  const { logger, records } = capturingLogger();
  const hooked: string[] = [];
  const service = inboundService({
    store,
    logger,
    onCustomerMessage: (_chat, message) => hooked.push(message.messageId),
  }).sinkFor({ kind: "telegram", connection: "main" });
  return { store, service, records, hooked };
}

test("saves a repeated notification once and reports the repeat as a duplicate", async () => {
  const { store, service, hooked } = await setup();
  expect(await service.accept(inbound("customer", "tg:1"))).toBe("saved");
  expect(await service.accept(inbound("customer", "tg:1"))).toBe("duplicate");

  const { events } = await store.read(chat);
  expect(events).toEqual([
    {
      type: "message",
      seq: 1,
      at: 1711935000000,
      recordedAt: 1711938600000,
      dedupKey: "tg:1",
      messageId: "tg:1",
      role: "customer",
      sender: { id: "u1", name: "Ali", known: true },
      parts: [{ kind: "text", text: "Hello" }],
      delivery: "received",
    },
  ]);
  expect(hooked).toEqual(["tg:1"]);
});

test("rejects a malformed event, logs it and saves nothing", async () => {
  const { store, service, records, hooked } = await setup();
  const malformed = { ...inbound("customer", "tg:1"), parts: [] };
  expect(await service.accept(malformed)).toBe("malformed");

  expect((await store.read(chat)).events).toEqual([]);
  expect(hooked).toEqual([]);
  expect(records.at(-1)).toMatchObject({
    level: 40,
    msg: "rejected a malformed inbound event",
    issues: ["parts: Too small: expected array to have >=1 items"],
  });
});

test("rejects a chat key that cannot be a folder name", async () => {
  const { service, records } = await setup();
  const unsafe = { ...inbound("customer", "tg:1"), chatKey: "../42" };
  expect(await service.accept(unsafe)).toBe("malformed");

  expect(records.at(-1)).toMatchObject({
    level: 40,
    msg: "rejected a malformed inbound event",
    issues: [
      'chatKey: expected a folder name of letters, digits, ".", "_" and "-", not starting with "."',
    ],
  });
});

test("operator and agent messages are saved without calling the customer hook", async () => {
  const { store, service, hooked } = await setup();
  expect(await service.accept(inbound("operator", "rio:1"))).toBe("saved");
  expect(await service.accept(inbound("agent", "rio:2"))).toBe("saved");

  const { events } = await store.read(chat);
  expect(
    events.map((event) => event.type === "message" && event.delivery),
  ).toEqual(["confirmed", "confirmed"]);
  expect(hooked).toEqual([]);
});

test("an echo of an own send that was not confirmed confirms it", async () => {
  const { store, service, hooked } = await setup();
  await store.append(chat, [
    {
      type: "message",
      at: t0,
      messageId: "a1",
      role: "agent",
      sender: { known: true },
      parts: [{ kind: "text", text: "Hi" }],
      delivery: "uncertain",
      externalId: "m9",
    },
  ]);
  expect(await service.accept(inbound("agent", "rio:9", "m9"))).toBe("saved");
  expect(await service.accept(inbound("agent", "rio:10", "m9"))).toBe(
    "duplicate",
  );

  const { events } = await store.read(chat);
  expect(events.map((event) => event.type)).toEqual([
    "message",
    "message-update",
  ]);
  expect(events[1]).toMatchObject({ messageId: "a1", delivery: "confirmed" });
  expect(hooked).toEqual([]);
});

test("maps a delivery update to its message and ignores one for an unknown message", async () => {
  const { store, service } = await setup();
  await service.accept(inbound("customer", "tg:1", "m1"));
  const update = (externalId: string, dedupKey: string): InboundEvent => ({
    type: "delivery-update",
    chatKey: "42",
    dedupKey,
    at: t0,
    externalId,
    delivery: "failed",
  });
  expect(await service.accept(update("m1", "rio:1"))).toBe("saved");
  expect(await service.accept(update("m2", "rio:2"))).toBe("ignored");

  const { events } = await store.read(chat);
  expect(events.at(-1)).toMatchObject({
    type: "message-update",
    messageId: "tg:1",
    delivery: "failed",
  });
  expect(events.length).toBe(2);
});

test("saves owner, status and note notifications from the channel", async () => {
  const { store, service } = await setup();
  const base = { chatKey: "42", at: t0 };
  await service.accept({
    ...base,
    type: "owner",
    dedupKey: "o1",
    owner: "human",
  });
  await service.accept({
    ...base,
    type: "status",
    dedupKey: "s1",
    status: "closed",
  });
  await service.accept({
    ...base,
    type: "note",
    dedupKey: "n1",
    author: "operator",
    text: "VIP",
  });

  const { state, events } = await store.read(chat);
  expect(state.owner).toEqual({
    kind: "human",
    at: 1711935000000,
    source: "channel",
  });
  expect(state.status).toBe("closed");
  expect(events.at(-1)).toMatchObject({
    type: "note",
    kind: "comment",
    author: "operator",
    text: "VIP",
  });
});
