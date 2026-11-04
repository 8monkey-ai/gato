import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { createEnvReader } from "../../config/env.ts";
import { createLogger } from "../../log.ts";
import type { InboundEvent } from "../channel.ts";
import { channelType } from "../registry.ts";
import "./index.ts";

test("creates a connection that takes webhooks only after start", async () => {
  const env = createEnvReader({
    GATO_CONNECTION_RIO_API_TOKEN: "tok",
    GATO_CONNECTION_RIO_SIGNING_KEYS: "key",
    GATO_CONNECTION_RIO_AGENT_USER_ID: "99",
  });
  const connection = await channelType("respondio")!.create(
    "rio",
    env.scope("GATO_CONNECTION_RIO_"),
    createLogger({}, () => {}),
  );
  const body =
    '{"event_type":"contact.assignee.updated","event_id":"e","contact":{"id":7}}';
  const post = () =>
    connection.routes!["/respondio/rio"]!(
      new Request("http://gato/respondio/rio", {
        method: "POST",
        body,
        headers: {
          "X-Webhook-Signature": createHmac("sha256", "key")
            .update(body)
            .digest("base64"),
        },
      }),
    );
  expect(Object.keys(connection.routes!)).toEqual(["/respondio/rio"]);
  expect("contactTools" in connection).toBe(false);
  expect([connection.maxTextLength, connection.supportsVideo]).toEqual([
    4096,
    true,
  ]);
  expect((await post()).status).toBe(503);
  const events: InboundEvent[] = [];
  await connection.start((event) => {
    events.push(event);
    return Promise.resolve();
  });
  expect((await post()).status).toBe(200);
  expect(events.map((event) => [event.kind, event.chatId])).toEqual([
    ["ownership", "7"],
  ]);
  await connection.stop();
});
