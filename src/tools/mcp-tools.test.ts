import { afterEach, expect, test } from "bun:test";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { createLogger } from "../log.ts";
import { connectWithTransport, type McpClient } from "./mcp-client.ts";
import { mcpAgentTools } from "./mcp-tools.ts";

const log = createLogger({}, () => {});
const signal = new AbortController().signal;
const opened: McpClient[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((client) => client.close()));
});

async function connect(server: McpServer | Server) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = await connectWithTransport("shop", clientSide, log);
  opened.push(client);
  return client;
}

function shopServer(calls: string[]) {
  const server = new McpServer({ name: "shop", version: "1.0.0" });
  server.registerTool(
    "lookup",
    { description: "Find an order", inputSchema: { orderId: z.string() } },
    ({ orderId }) => {
      calls.push(orderId);
      return orderId === "broken"
        ? { isError: true, content: [{ type: "text", text: "Lookup failed" }] }
        : { content: [{ type: "text", text: `No order ${orderId}` }] };
    },
  );
  server.registerTool(
    "get.status",
    { description: "Shop status", outputSchema: { open: z.boolean() } },
    () => ({
      content: [{ type: "text", text: '{"open":true}' }],
      structuredContent: { open: true },
    }),
  );
  return server;
}

test("names tools with the prefix and keeps the server description and schema", async () => {
  const client = await connect(shopServer([]));
  const tools = await mcpAgentTools(client, { prefix: "shop", permitted: "*" });
  expect(tools.map((t) => [t.name, t.description])).toEqual([
    ["shop_lookup", "Find an order"],
    ["shop_get_status", "Shop status"],
  ]);
  expect(tools[0]?.inputSchema).toMatchObject({
    type: "object",
    properties: { orderId: { type: "string" } },
    required: ["orderId"],
  });
});

test("offers only the permitted tools", async () => {
  const client = await connect(shopServer([]));
  const tools = await mcpAgentTools(client, {
    prefix: "shop",
    permitted: ["get.status"],
  });
  expect(tools.map((t) => t.name)).toEqual(["shop_get_status"]);
});

test("a permitted tool the server does not offer is a configuration error", async () => {
  const client = await connect(shopServer([]));
  await expect(
    mcpAgentTools(client, { prefix: "shop", permitted: ["lookup", "refund"] }),
  ).rejects.toThrow(
    'MCP server "shop" does not offer the permitted tools: refund',
  );
});

test("keeps a negative business result apart from a failed tool", async () => {
  const client = await connect(shopServer([]));
  const [lookup, status] = await mcpAgentTools(client, {
    prefix: "shop",
    permitted: "*",
  });
  expect(await lookup?.execute({ orderId: "A1" }, signal)).toEqual({
    isError: false,
    output: [{ type: "text", text: "No order A1" }],
  });
  expect(await lookup?.execute({ orderId: "broken" }, signal)).toEqual({
    isError: true,
    output: [{ type: "text", text: "Lookup failed" }],
  });
  expect(await status?.execute({}, signal)).toEqual({
    isError: false,
    output: { open: true },
  });
});

test("a call that throws becomes a failed outcome with the error message", async () => {
  const client = await connect(shopServer([]));
  const [lookup] = await mcpAgentTools(client, {
    prefix: "shop",
    permitted: ["lookup"],
  });
  await client.close();
  expect(await lookup?.execute({ orderId: "A1" }, signal)).toEqual({
    isError: true,
    output: "Not connected",
  });
  expect(await lookup?.execute("A1", signal)).toEqual({
    isError: true,
    output: "Tool input must be a JSON object",
  });
});

test("a rejected input does not reach the server", async () => {
  const calls: string[] = [];
  const client = await connect(shopServer(calls));
  const [lookup] = await mcpAgentTools(client, {
    prefix: "shop",
    permitted: ["lookup"],
    transformInput: (name, input) =>
      (input as { orderId: string }).orderId === "A1"
        ? { ok: true, input: { orderId: "A1-checked" } }
        : { ok: false, reason: `${name} is limited to order A1` },
  });
  expect(await lookup?.execute({ orderId: "B2" }, signal)).toEqual({
    isError: true,
    output: "Not permitted: lookup is limited to order A1",
  });
  await lookup?.execute({ orderId: "A1" }, signal);
  expect(calls).toEqual(["A1-checked"]);
});

test("reads every page of the tool list", async () => {
  const server = new Server(
    { name: "paged", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, ({ params }) => {
    const name = params?.cursor === "2" ? "second" : "first";
    const tool = { name, inputSchema: { type: "object" as const } };
    return { tools: [tool], nextCursor: params?.cursor ? undefined : "2" };
  });
  const client = await connect(server);
  expect(await client.tools()).toEqual([
    { name: "first", description: "", inputSchema: { type: "object" } },
    { name: "second", description: "", inputSchema: { type: "object" } },
  ]);
});
