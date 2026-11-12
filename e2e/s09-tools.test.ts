import { afterEach, expect, test } from "bun:test";

import { z } from "zod";

import { readChat, startApp, waitUntil } from "./support/app.ts";
import { respondioTools, startFakeMcp } from "./support/fake-mcp.ts";
import { contentText, type LlmRequest } from "./support/fake-openrouter.ts";
import { messageEvent, notify } from "./support/fake-respondio.ts";
import { createWorld, type World } from "./support/world.ts";

let world: World;
let stops: (() => unknown)[] = [];
afterEach(async () => {
  await world.close();
  for (const stop of stops) await stop();
  stops = [];
});

const toolNames = (request: LlmRequest) =>
  (request.tools ?? []).map((t) => t.function.name).sort();
const callOnce =
  (calls: { name: string; args: object }[]) => (request: LlmRequest) =>
    request.messages.some((m) => m.role === "tool")
      ? { text: "Done." }
      : { toolCalls: calls };
const toolResults = (request: LlmRequest) =>
  request.messages
    .filter((m) => m.role === "tool")
    .map((m) => contentText(m.content));

function crm() {
  const fake = startFakeMcp({
    lookup_order: {
      description: "Find an order.",
      input: { order: z.string() },
      result: ({ order }) => ({ text: `Order ${String(order)} shipped` }),
    },
    cancel_order: {
      description: "Cancel an order.",
      input: { order: z.string() },
    },
  });
  stops.push(fake.stop);
  return {
    fake,
    env: {
      MCP_SERVERS: "crm",
      MCP_CRM_URL: fake.url,
      MCP_CRM_BEARER_TOKEN: fake.bearerToken,
      MCP_CRM_TOOLS: "lookup_order",
    },
  };
}

function respondioMcp(extra: Record<string, string> = {}) {
  const fake = startFakeMcp(respondioTools());
  stops.push(fake.stop);
  return {
    fake,
    env: {
      RESPONDIO_MAIN_MCP_URL: fake.url,
      RESPONDIO_MAIN_MCP_BEARER_TOKEN: fake.bearerToken,
      ...extra,
    },
  };
}

test("§9 only permitted tools are offered, with authentication, and results reach the agent", async () => {
  world = await createWorld();
  const { fake, env } = crm();
  world.llm.respond(
    callOnce([{ name: "lookup_order", args: { order: "A1" } }]),
  );
  await world.start(env);
  world.telegram.push(42, { text: "Where is A1?" });
  await waitUntil(() => world.telegram.sent.length);

  const [first, second] = world.llm.mainRequests();
  expect(toolNames(first!)).toEqual(["lookup_order", "read_skill"]);
  expect(fake.calls).toEqual([{ name: "lookup_order", args: { order: "A1" } }]);
  expect(toolResults(second!)[0]).toContain("Order A1 shipped");
  expect(fake.authorizations.every((a) => a === "Bearer mcp-secret")).toBe(
    true,
  );
});

test("§9 a permitted tool that the server does not offer prevents startup", async () => {
  world = await createWorld();
  const { env } = crm();
  const app = await startApp({
    ...world.baseEnv,
    ...world.telegramEnv,
    ...env,
    MCP_CRM_TOOLS: "refund_order",
  });
  expect(app.started).toBe(false);
  expect(app.startError).toContain("refund_order");
});

test("§9 contact tools act only on the current contact and reject disallowed changes", async () => {
  world = await createWorld();
  const { fake, env } = respondioMcp();
  world.llm.respond(
    callOnce([
      { name: "get_contact", args: {} },
      { name: "update_contact", args: { email: "x@y.z" } },
      { name: "add_contact_tags", args: { tags: ["vip"] } },
      { name: "update_contact", args: { firstName: "Ana" } },
    ]),
  );
  const app = await world.start(env, "respondio");
  await notify(
    app.url,
    "main",
    messageEvent({ contact: 5, traffic: "incoming", text: "I am Ana" }),
    world.respondio.signingKey,
  );
  await waitUntil(() => world.respondio.sent.length);

  const first = world.llm.mainRequests()[0]!;
  expect(toolNames(first)).toEqual(
    [
      "read_skill",
      "add_contact_tags",
      "create_comment",
      "get_contact",
      "update_contact",
    ]
      .concat("handoff_to_colleague")
      .sort(),
  );
  expect(JSON.stringify(first.tools)).not.toContain("identifier");
  expect(fake.calls).toEqual([
    { name: "get_contact", args: { identifier: "id:5" } },
    {
      name: "update_contact",
      args: { identifier: "id:5", firstName: "Ana" },
    },
  ]);
});

test("§9 respond.io contact tools are not offered to Telegram conversations", async () => {
  world = await createWorld();
  const { env } = respondioMcp();
  await world.start(env, "both");
  world.telegram.push(42, { text: "Hi" });
  await waitUntil(() => world.telegram.sent.length);
  expect(toolNames(world.llm.mainRequests()[0]!)).toEqual(["read_skill"]);
});

test("§9 tools that reach beyond the current contact cannot be permitted", async () => {
  world = await createWorld();
  const { env } = respondioMcp({
    RESPONDIO_MAIN_MCP_TOOLS: "get_contact,list_contacts",
  });
  const app = await startApp({
    ...world.baseEnv,
    ...world.respondioEnv,
    ...env,
  });
  expect(app.started).toBe(false);
  expect(app.startError).toContain("list_contacts");
});

test("§9 two tools with the same name fail the turn visibly instead of choosing one", async () => {
  world = await createWorld();
  const shop = startFakeMcp({
    get_contact: { description: "Shop contact.", input: {} },
  });
  stops.push(shop.stop);
  const { env } = respondioMcp();
  const business = {
    MCP_SERVERS: "shop",
    MCP_SHOP_URL: shop.url,
    MCP_SHOP_BEARER_TOKEN: "mcp-secret",
    MCP_SHOP_TOOLS: "get_contact",
  };
  const app = await world.start({ ...env, ...business }, "respondio");
  await notify(
    app.url,
    "main",
    messageEvent({ contact: 5, traffic: "incoming", text: "Hi" }),
    world.respondio.signingKey,
  );

  const ended = await app.waitForLog("turn.ended");
  expect(ended.outcome).toBe("failed");
  expect(String(ended.detail)).toContain(
    'More than one tool is named "get_contact"',
  );
  expect(world.respondio.sent).toHaveLength(0);
});

function phoneShop(result: { isError?: boolean }) {
  const devices = {
    devices: [{ model: "Used iPhone 16 Pro Max 256GB", condition: "USED" }],
  };
  const fake = startFakeMcp({
    find_devices: {
      description: "Find devices.",
      input: {},
      result: () => ({
        text: result.isError ? "Stock service down" : JSON.stringify(devices),
        structured: devices,
        ...result,
      }),
    },
  });
  stops.push(fake.stop);
  return {
    MCP_SERVERS: "shop",
    MCP_SHOP_URL: fake.url,
    MCP_SHOP_BEARER_TOKEN: fake.bearerToken,
    MCP_SHOP_TOOLS: "find_devices",
  };
}

async function askForDevices(env: Record<string, string>) {
  world = await createWorld();
  world.llm.respond(callOnce([{ name: "find_devices", args: {} }]));
  await world.start(env);
  world.telegram.push(42, { text: "Any iPhones?" });
  await waitUntil(() => world.telegram.sent.length);
  return toolResults(world.llm.mainRequests()[1]!)[0]!;
}

test("§9 structured tool results reach the agent and the record as an object", async () => {
  const result = await askForDevices(phoneShop({}));

  expect(result).toContain(
    '"structuredContent":{"devices":[{"model":"Used iPhone 16 Pro Max 256GB","condition":"USED"}]}',
  );
  expect(result).not.toContain('\\"devices\\"');
  const chat = await readChat(world.dataDir, world.telegram.connectionId, "42");
  const record = chat.find((e) => e.tag === "tool")!.text;
  expect(record).toContain(
    '"structuredContent":{"devices":[{"model":"Used iPhone 16 Pro Max 256GB","condition":"USED"}]}',
  );
  expect(record).not.toContain('\\"devices\\"');
});

test("§9 an error tool result keeps its text even with structured content", async () => {
  const result = await askForDevices(phoneShop({ isError: true }));

  expect(result).toContain('"isError":true');
  expect(result).toContain("Stock service down");
});
