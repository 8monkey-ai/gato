import { expect, test } from "bun:test";

import { z } from "zod";

import { startApp } from "./support/app.ts";
import type { ChatRequest, Reply } from "./support/fake-gateway.ts";
import { fakeMcp, respondioTools } from "./support/fake-mcp.ts";
import { messageEvent, postWebhook } from "./support/fake-respondio.ts";
import { until } from "./support/recorder.ts";
import { onCleanup, startHarness } from "./support/setup.ts";

function respondioMcp() {
  const { list_contacts: _, ...tools } = respondioTools;
  const mcp = fakeMcp(tools);
  onCleanup(() => mcp.stop());
  return mcp;
}

const mcpEnv = (url: string) => ({
  RESPONDIO_MCP_URL: url,
  RESPONDIO_MCP_TOKEN: "mcp-token",
});
const toolMessages = (request: ChatRequest | undefined) =>
  JSON.stringify(request?.messages.filter((m) => m.role === "tool"));

/** The first model call asks for the tool; the next one answers. */
const callThenAnswer =
  (name: string, args: unknown) =>
  (_: ChatRequest, index: number): Reply =>
    index % 2 === 0 ? { toolCalls: [{ name, args }] } : { text: "Done." };

test("§9 respond.io tools: contact tools act on the current contact only, with the static bearer token", async () => {
  const mcp = respondioMcp();
  const { app, gateway, respondio } = await startHarness({
    channels: "respondio",
    env: mcpEnv(mcp.url),
  });
  gateway.script(
    callThenAnswer("respondio_get_contact", { identifier: "id:999" }),
  );
  await postWebhook(app.url, messageEvent({ contact: 130, text: "who am I?" }));
  await until(() => respondio.sent().length === 1);

  const tools = gateway.requests[0]?.tools?.map((t) => t.function.name).sort();
  expect(tools).toEqual([
    "handoff",
    "read_skill",
    "respondio_add_contact_tags",
    "respondio_create_comment",
    "respondio_get_contact",
    "respondio_update_contact",
  ]);
  expect(JSON.stringify(gateway.requests[0]?.tools)).not.toContain(
    '"identifier"',
  );
  expect(mcp.calls).toEqual([
    {
      name: "get_contact",
      args: { identifier: "id:130" },
      authorization: "Bearer mcp-token",
    },
  ]);
});

test("§9 respond.io tools: disallowed field edits and labels are rejected without being applied", async () => {
  const mcp = respondioMcp();
  const { app, gateway, respondio } = await startHarness({
    channels: "respondio",
    env: mcpEnv(mcp.url),
  });
  gateway.script(
    callThenAnswer("respondio_update_contact", { email: "x@example.com" }),
  );
  await postWebhook(
    app.url,
    messageEvent({ contact: 131, text: "my email is x@example.com" }),
  );
  await until(() => respondio.sent().length === 1);
  expect(toolMessages(gateway.requests[1])).toContain("not permitted");

  gateway.script(
    callThenAnswer("respondio_add_contact_tags", { tags: ["vip"] }),
  );
  await postWebhook(app.url, messageEvent({ contact: 131, text: "tag me" }));
  await until(() => respondio.sent().length === 2);
  expect(toolMessages(gateway.requests[3])).toContain("not permitted");
  expect(mcp.calls).toHaveLength(0);

  gateway.script(
    callThenAnswer("respondio_update_contact", { firstName: "Siti" }),
  );
  await postWebhook(
    app.url,
    messageEvent({ contact: 131, text: "call me Siti" }),
  );
  await until(() => respondio.sent().length === 3);
  expect(mcp.calls).toEqual([
    {
      name: "update_contact",
      args: { firstName: "Siti", identifier: "id:131" },
      authorization: "Bearer mcp-token",
    },
  ]);
});

test("§9 respond.io tools: Telegram conversations do not get respond.io contact tools", async () => {
  const mcp = respondioMcp();
  const { telegram, gateway } = await startHarness({
    channels: "telegram,respondio",
    env: mcpEnv(mcp.url),
  });
  telegram.push(132, { text: "hi" });
  await until(() => telegram.sent().length === 1);
  expect(gateway.requests[0]?.tools?.map((t) => t.function.name)).toEqual([
    "read_skill",
  ]);
});

test("§9 respond.io tools: a permission that cannot be limited to the current contact is refused", async () => {
  const mcp = fakeMcp(respondioTools);
  onCleanup(() => mcp.stop());
  const { env } = await startHarness({
    channels: "respondio",
    env: mcpEnv(mcp.url),
  });
  const app = await startApp(
    { ...env, RESPONDIO_MCP_TOOLS: "get_contact,list_contacts" },
    { waitReady: false },
  );
  expect(await app.exited).toBe(1);
  expect(app.logs.join("\n")).toContain(
    "list_contacts cannot be limited to the current contact",
  );
});

test("§9 business tools: permitted MCP tools carry their server name, and a failed tool is reported as a failure", async () => {
  const crm = fakeMcp({
    lookup: { shape: { order: z.string() }, error: "CRM unavailable" },
    secret: { shape: {} },
  });
  onCleanup(() => crm.stop());
  const servers = [
    {
      name: "crm",
      url: crm.url,
      headers: { Authorization: "Bearer crm-key" },
      tools: ["lookup"],
    },
  ];
  const { telegram, gateway } = await startHarness({
    env: { MCP_SERVERS: JSON.stringify(servers) },
  });
  gateway.script(callThenAnswer("crm_lookup", { order: "A1" }));
  telegram.push(133, { text: "where is order A1?" });
  await until(() => telegram.sent().length === 1);

  expect(gateway.requests[0]?.tools?.map((t) => t.function.name)).toEqual([
    "read_skill",
    "crm_lookup",
  ]);
  expect(crm.calls).toEqual([
    { name: "lookup", args: { order: "A1" }, authorization: "Bearer crm-key" },
  ]);
  expect(toolMessages(gateway.requests[1])).toContain("CRM unavailable");
});
