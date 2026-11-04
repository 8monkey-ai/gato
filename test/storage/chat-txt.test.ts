import { expect, test } from "bun:test";

import type { ChatEvent } from "../../src/conversation/events.ts";
import { renderChat } from "../../src/storage/chat-txt.ts";

// 01:30 UTC is 09:30 in Kuala Lumpur.
const at = Date.UTC(2024, 3, 1, 1, 30);

function message(
  seq: number,
  minute: number,
  fields: Partial<Extract<ChatEvent, { type: "message" }>>,
): ChatEvent {
  return {
    type: "message",
    seq,
    at: at + minute * 60_000,
    recordedAt: at,
    messageId: `m${seq}`,
    role: "customer",
    sender: { name: "Ali", known: true },
    parts: [{ kind: "text", text: "Hello" }],
    delivery: "received",
    ...fields,
  };
}

const conversation: ChatEvent[] = [
  message(1, 0, { parts: [{ kind: "text", text: "Hello\nI need help" }] }),
  message(2, 2, {
    role: "agent",
    sender: { known: true },
    parts: [{ kind: "text", text: "How can I help?" }],
    delivery: "attempting",
  }),
  {
    type: "message-update",
    seq: 3,
    at: at + 180_000,
    recordedAt: at,
    messageId: "m2",
    delivery: "uncertain",
  },
  message(4, 1, {
    role: "operator",
    sender: { known: false },
    parts: [{ kind: "text", text: "Hi" }],
  }),
  message(5, 3, {
    role: "workflow",
    sender: { name: "Welcome", known: false },
  }),
  {
    type: "note",
    seq: 6,
    at: at + 240_000,
    recordedAt: at,
    kind: "comment",
    author: "operator",
    text: "VIP",
  },
  message(7, 5, {
    parts: [{ kind: "text", text: "Nudge" }],
    internalTrigger: "nudge",
  }),
  {
    type: "owner",
    seq: 8,
    at: at + 360_000,
    recordedAt: at,
    owner: "human",
    source: "channel",
  },
];

test("renders messages and internal notes in chat order with sender attribution", () => {
  expect(renderChat(conversation, "Asia/Kuala_Lumpur")).toBe(
    [
      "[2024-04-01 09:30:00 +08:00] Customer (Ali): Hello",
      "  I need help",
      "[2024-04-01 09:31:00 +08:00] Operator (unknown sender): Hi",
      "[2024-04-01 09:32:00 +08:00] Agent [uncertain]: How can I help?",
      "[2024-04-01 09:33:00 +08:00] Workflow (Welcome, unconfirmed): Hello",
      "[2024-04-01 09:34:00 +08:00] Internal note (comment, by operator): VIP",
      "[2024-04-01 09:35:00 +08:00] Internal nudge trigger: Nudge",
      "",
    ].join("\n"),
  );
});
