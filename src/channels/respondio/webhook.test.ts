import { expect, test } from "bun:test";

import { parseWebhook } from "./webhook.ts";

const event = (
  extra: Record<string, unknown>,
  message: Record<string, unknown> = {},
) => ({
  event_type: "message.sent",
  contact: { id: 1, firstName: "Siti", assignee: null },
  message: {
    messageId: 9,
    traffic: "outgoing",
    timestamp: 1_700_000_000,
    message: { type: "text", text: "x" },
    ...message,
  },
  ...extra,
});

const role = (body: unknown) => {
  const parsed = parseWebhook(body, 77);
  return parsed.kind === "message"
    ? [parsed.message.role, parsed.message.sender ?? null]
    : parsed.kind;
};

test("classification follows the order of the specification", () => {
  expect(
    role(event({ event_type: "message.received" }, { traffic: "incoming" })),
  ).toEqual(["customer", "Siti"]);
  expect(role(event({ sender: { source: "workflow" } }))).toEqual([
    "workflow",
    null,
  ]);
  expect(role(event({ sender: { source: "api" } }))).toEqual(["agent", null]);
  expect(role(event({ sender: { source: "user", userId: 77 } }))).toEqual([
    "agent",
    null,
  ]);
  expect(
    role(
      event({
        sender: { source: "user", userId: 5 },
        user: { firstName: "Sarah" },
      }),
    ),
  ).toEqual(["operator", "Sarah"]);
  expect(role(event({}))).toEqual(["operator", null]);
});

test("seconds become milliseconds, and ownership decides whether a customer message is answerable", () => {
  const parsed = parseWebhook(
    event(
      {
        event_type: "message.received",
        contact: { id: 1, assignee: { id: 5 } },
      },
      { traffic: "incoming" },
    ),
    77,
  );
  expect(parsed).toMatchObject({
    kind: "message",
    message: { answerable: false, at: new Date(1_700_000_000_000) },
  });
});

test("other events are irrelevant and broken message events are malformed", () => {
  expect(parseWebhook({ event_type: "contact.updated" }, 77)).toEqual({
    kind: "irrelevant",
  });
  expect(parseWebhook({ event_type: "message.received" }, 77).kind).toBe(
    "malformed",
  );
});
