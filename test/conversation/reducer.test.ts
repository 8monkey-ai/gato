import { expect, test } from "bun:test";

import type {
  ChatEvent,
  DeliveryState,
} from "../../src/conversation/events.ts";
import { applyEvents } from "../../src/conversation/reducer.ts";
import { newChatState } from "../../src/conversation/state.ts";

const start = newChatState(
  { kind: "telegram", connection: "main", chatKey: "42" },
  { status: "open", owner: { kind: "agent", source: "local" } },
);

function message(
  seq: number,
  at: number,
  role: "customer" | "operator" | "workflow" | "agent",
  internalTrigger?: "nudge",
  delivery: DeliveryState = "received",
): ChatEvent {
  return {
    type: "message",
    seq,
    at,
    recordedAt: 9000,
    messageId: `m${seq}`,
    role,
    sender: { known: true },
    parts: [{ kind: "text", text: "hi" }],
    delivery,
    internalTrigger,
  };
}

function owner(seq: number, at: number, kind: "agent" | "human"): ChatEvent {
  return {
    type: "owner",
    seq,
    at,
    recordedAt: 9000,
    owner: kind,
    source: "channel",
  };
}

test("a new chat state uses the supplied start values with time 0", () => {
  expect(start).toEqual({
    version: 1,
    appliedSeq: 0,
    chat: { kind: "telegram", connection: "main", chatKey: "42" },
    status: "open",
    statusAt: 0,
    owner: { kind: "agent", at: 0, source: "local" },
    labels: [],
    activity: {},
  });
});

test("an older owner event does not replace a newer owner", () => {
  const state = applyEvents(start, [
    owner(1, 2000, "human"),
    owner(2, 1000, "agent"),
  ]);
  expect(state.owner).toEqual({ kind: "human", at: 2000, source: "channel" });
  expect(state.appliedSeq).toBe(2);
});

test("an older status event does not replace a newer status", () => {
  const state = applyEvents(start, [
    { type: "status", seq: 1, at: 2000, recordedAt: 9000, status: "closed" },
    { type: "status", seq: 2, at: 1000, recordedAt: 9000, status: "open" },
  ]);
  expect([state.status, state.statusAt]).toEqual(["closed", 2000]);
});

test("a delayed message does not move activity back", () => {
  const state = applyEvents(start, [
    message(1, 2000, "customer"),
    message(2, 1000, "customer"),
  ]);
  expect(state.activity).toEqual({ lastCustomerAt: 2000 });
});

test("each role moves its own activity", () => {
  const state = applyEvents(start, [
    message(1, 1000, "customer"),
    message(2, 2000, "operator"),
    message(3, 3000, "workflow"),
    message(4, 4000, "agent"),
  ]);
  expect(state.activity).toEqual({
    lastCustomerAt: 1000,
    lastOperatorAt: 2000,
    lastWorkflowAt: 3000,
    lastAgentAt: 4000,
  });
});

test("an internal trigger message is not customer activity", () => {
  const state = applyEvents(start, [message(1, 1000, "customer", "nudge")]);
  expect(state.activity).toEqual({});
});

function update(seq: number, messageId: string, delivery: DeliveryState) {
  return {
    type: "message-update",
    seq,
    at: 9000,
    recordedAt: 9000,
    messageId,
    delivery,
  } satisfies ChatEvent;
}

test("an agent message that is not sent does not move agent activity", () => {
  const state = applyEvents(start, [
    message(1, 1000, "agent", undefined, "generated"),
    message(2, 2000, "agent", undefined, "failed"),
    message(3, 3000, "agent", undefined, "cancelled"),
    message(4, 4000, "agent", undefined, "attempting"),
  ]);
  expect(state.activity).toEqual({});
});

test("an update to confirmed or uncertain moves activity to the message's sent time", () => {
  const state = applyEvents(start, [
    message(1, 1000, "agent", undefined, "attempting"),
    message(2, 2000, "operator", undefined, "attempting"),
    update(3, "m1", "confirmed"),
    update(4, "m2", "uncertain"),
  ]);
  expect(state.activity).toEqual({ lastAgentAt: 1000, lastOperatorAt: 2000 });
});

test("an update to failed does not move activity", () => {
  const state = applyEvents(start, [
    message(1, 1000, "agent", undefined, "attempting"),
    update(2, "m1", "failed"),
  ]);
  expect(state.activity).toEqual({});
});

test("applies only the events after appliedSeq and finds earlier messages for updates", () => {
  const record: ChatEvent[] = [
    {
      type: "label",
      seq: 1,
      at: 1000,
      recordedAt: 9000,
      action: "add",
      label: "vip",
      origin: "operator",
    },
    message(2, 1000, "agent", undefined, "attempting"),
    update(3, "m2", "confirmed"),
  ];
  const saved = applyEvents(start, record.slice(0, 2));
  const state = applyEvents({ ...saved, labels: [] }, record);
  expect([state.appliedSeq, state.labels, state.activity]).toEqual([
    3,
    [],
    { lastAgentAt: 1000 },
  ]);
});

test("only agent notes move agent activity", () => {
  const note = (
    seq: number,
    at: number,
    author: "agent" | "operator",
  ): ChatEvent => ({
    type: "note",
    seq,
    at,
    recordedAt: 9000,
    kind: "nudge",
    author,
    text: "Nudge",
  });
  expect(applyEvents(start, [note(1, 1000, "operator")]).activity).toEqual({});
  expect(applyEvents(start, [note(1, 1000, "agent")]).activity).toEqual({
    lastAgentAt: 1000,
  });
});

test("labels are added once and removed", () => {
  const label = (
    seq: number,
    action: "add" | "remove",
    name: string,
  ): ChatEvent => ({
    type: "label",
    seq,
    at: 1000,
    recordedAt: 9000,
    action,
    label: name,
    origin: "agent",
  });
  const state = applyEvents(start, [
    label(1, "add", "handoff"),
    label(2, "add", "vip"),
    label(3, "add", "handoff"),
    label(4, "remove", "vip"),
  ]);
  expect(state.labels).toEqual(["handoff"]);
});

test("an update of an unknown message only moves appliedSeq", () => {
  const state = applyEvents(start, [update(1, "m9", "confirmed")]);
  expect(state).toEqual({ ...start, appliedSeq: 1 });
});
