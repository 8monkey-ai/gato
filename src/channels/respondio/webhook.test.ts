import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { createLogger } from "../../log.ts";
import type { InboundEvent } from "../channel.ts";
import { webhookHandler } from "./webhook.ts";

const assigned = JSON.stringify({
  event_type: "contact.assignee.updated",
  event_id: "evt-1",
  contact: { id: 7, assignee: null },
});

function setup(sink = (_event: InboundEvent) => Promise.resolve()) {
  const events: InboundEvent[] = [];
  const logs: string[] = [];
  const handler = webhookHandler({
    signingKeys: ["key"],
    agentUserId: "99",
    sink: () => (event) => {
      events.push(event);
      return sink(event);
    },
    log: createLogger({}, (line) => logs.push(line)),
    now: () => new Date("2026-11-04T10:00:00.000Z"),
  });
  const post = (body: string, signature?: string) =>
    handler(
      new Request("http://gato/respondio/rio", {
        method: "POST",
        body,
        headers: {
          "X-Webhook-Signature":
            signature ??
            createHmac("sha256", "key").update(body).digest("base64"),
        },
      }),
    );
  return { post, events, logs };
}

test("saves a signed event before it answers 200", async () => {
  const { post, events } = setup();
  const response = await post(assigned);
  expect(response.status).toBe(200);
  expect(events).toEqual([
    {
      kind: "ownership",
      chatId: "7",
      eventId: "evt-1",
      at: new Date("2026-11-04T10:00:00.000Z"),
      owner: "none",
    },
  ]);
});

test("refuses a bad signature with 401", async () => {
  const { post, events } = setup();
  expect((await post(assigned, "bad")).status).toBe(401);
  expect(events).toEqual([]);
});

test("acknowledges malformed and ignored payloads without ingest", async () => {
  const { post, events, logs } = setup();
  expect((await post("{not json")).status).toBe(200);
  expect((await post('{"event_type":"message.sent","x":1}')).status).toBe(200);
  expect((await post('{"event_type":"contact.created"}')).status).toBe(200);
  expect(events).toEqual([]);
  expect(
    logs.map((line) => (JSON.parse(line) as { event: string }).event),
  ).toEqual(["respondio_malformed_webhook", "respondio_malformed_webhook"]);
});

test("answers 500 when the event cannot be saved, so respond.io retries", async () => {
  const { post } = setup(() => Promise.reject(new Error("disk full")));
  expect((await post(assigned)).status).toBe(500);
});
