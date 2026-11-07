import { afterEach, expect, test } from "bun:test";

import { type App, readChat, waitUntil } from "./support/app.ts";
import {
  contentText,
  lastUserText,
  type LlmRequest,
} from "./support/fake-openrouter.ts";
import { messageEvent, notify } from "./support/fake-respondio.ts";
import { createWorld, type World } from "./support/world.ts";

let world: World;
afterEach(async () => world.close());

const visible = (request: LlmRequest) =>
  request.messages
    .filter((m) => m.role !== "system")
    .map((m) => [m.role, contentText(m.content)]);

function sender(app: App) {
  const send = (event: Parameters<typeof messageEvent>[0]) =>
    notify(app.url, "main", messageEvent(event), world.respondio.signingKey);
  return {
    send,
    customer: (text: string) => send({ contact: 5, traffic: "incoming", text }),
    echo: (text = "", messageId = 0) =>
      send({
        contact: 5,
        traffic: "outgoing",
        text,
        sender: { source: "api" },
        messageId,
      }),
    operator: (
      text: string,
      attachment?: { type: string; url: string; fileName: string },
    ) =>
      send({
        contact: 5,
        traffic: "outgoing",
        text,
        attachment,
        sender: { source: "user", userId: 3 },
      }),
  };
}

test("Journey 1: shared service keeps every contribution attributed and echoes appear once", async () => {
  world = await createWorld();
  world.respondio.files.set("map.png", new Uint8Array([1, 2, 3]));
  world.llm.respond((request) => ({
    text: `Answer to ${lastUserText(request)}`,
  }));
  const app = await world.start({}, "respondio");
  const { customer, echo, operator } = sender(app);

  await customer("Hello");
  const reply = await waitUntil(() => world.respondio.sent[0]);
  await echo(reply.message.text, reply.messageId);
  world.respondio.assign("5", 3);
  await operator("Here is our map", {
    type: "image",
    url: world.respondio.fileUrl("map.png"),
    fileName: "map.png",
  });
  await customer("Thanks Bob");
  await app.waitForLog("turn.not_agent_owned");
  world.respondio.assign("5", null);
  await customer("One more question");
  await waitUntil(() => world.respondio.sent.length === 2);

  expect(visible(world.llm.mainRequests()[1]!)).toEqual([
    ["user", "Hello"],
    ["assistant", "Answer to Hello"],
    [
      "assistant",
      "[Human colleague] Here is our map [1 file(s), shown in the next message]",
    ],
    [
      "user",
      "[Files that the operator in the message above sent to the customer. They are not from the customer.] <image_url>",
    ],
    ["user", "Thanks Bob"],
    ["user", "One more question"],
  ]);
  const tags = (await readChat(world.dataDir, "respondio-main", "5")).map(
    (e) => e.tag,
  );
  expect(tags).toEqual([
    "customer",
    "agent",
    "turn",
    "operator",
    "customer",
    "customer",
    "agent",
    "turn",
  ]);
});

test("Journey 2: an in-flight send that is later confirmed is part of the next turn", async () => {
  world = await createWorld();
  world.llm.respond((request) =>
    lastUserText(request) === "Hi"
      ? { text: "One.\n\nTwo." }
      : { text: "Okay." },
  );
  const app = await world.start({}, "respondio");
  const { customer, echo } = sender(app);
  world.respondio.setSendDelay(400);
  await customer("Hi");
  await waitUntil(() => world.llm.requests.length);
  await Bun.sleep(150);
  await customer("Actually, wait");
  const first = await waitUntil(() => world.respondio.sent[0]);
  world.respondio.setSendDelay(0);
  await echo("One.", first.messageId);

  await waitUntil(() => world.respondio.sent.length === 2);
  expect(world.respondio.sent.map((s) => s.message.text)).toEqual([
    "One.",
    "Okay.",
  ]);
  expect(visible(world.llm.mainRequests()[1]!)).toEqual([
    ["user", "Hi"],
    ["assistant", "One."],
    ["user", "Actually, wait"],
  ]);
  const agent = (await readChat(world.dataDir, "respondio-main", "5")).filter(
    (e) => e.tag === "agent",
  );
  expect(agent.map((e) => [e.text, e.meta.delivery])).toEqual([
    ["One.", "confirmed"],
    ["Two.", "unsent"],
    ["Okay.", "sent"],
  ]);
});
