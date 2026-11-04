import { afterEach, expect, test } from "bun:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createEnvReader } from "../config/env.ts";
import { createLogger } from "../log.ts";
import { connectMcpServers, readMcpServers } from "./mcp-servers.ts";

const log = createLogger({}, () => {});
const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

test("reads http, sse and stdio servers", () => {
  const env = createEnvReader({
    GATO_MCP_SHOP_URL: "https://shop.example/mcp",
    GATO_MCP_SHOP_TOKEN_ENV: "SHOP_TOKEN",
    GATO_MCP_SHOP_TOOLS: "lookup, refund",
    SHOP_TOKEN: "secret",
    GATO_MCP_CRM_LIVE_TRANSPORT: "sse",
    GATO_MCP_CRM_LIVE_URL: "http://crm.local/sse",
    GATO_MCP_CRM_LIVE_TOOLS: "*",
    GATO_MCP_FILES_TRANSPORT: "stdio",
    GATO_MCP_FILES_COMMAND: "files-mcp",
    GATO_MCP_FILES_ARGS: "--root,/data",
    GATO_MCP_FILES_TOOLS: "read",
  });
  const servers = readMcpServers(env, ["shop", "crm-live", "files"]);
  env.assertValid();
  expect(servers).toEqual([
    {
      id: "shop",
      transport: "http",
      url: "https://shop.example/mcp",
      headers: { Authorization: "Bearer secret" },
      permitted: ["lookup", "refund"],
    },
    {
      id: "crm-live",
      transport: "sse",
      url: "http://crm.local/sse",
      headers: undefined,
      permitted: "*",
    },
    {
      id: "files",
      transport: "stdio",
      command: "files-mcp",
      args: ["--root", "/data"],
      permitted: ["read"],
    },
  ]);
});

test("lists every invalid server setting", () => {
  const env = createEnvReader({
    GATO_MCP_A_TOKEN_ENV: "A_TOKEN",
    GATO_MCP_B_TRANSPORT: "stdio",
    GATO_MCP_B_TOKEN_ENV: "B_TOKEN",
    GATO_MCP_B_TOOLS: "*",
    GATO_MCP_C_TRANSPORT: "ws",
    GATO_MCP_C_URL: "ftp://c.example",
    GATO_MCP_C_TOOLS: ",",
  });
  readMcpServers(env, ["a", "b", "c"]);
  expect(() => env.assertValid()).toThrow(
    [
      "Invalid configuration:",
      "  - GATO_MCP_A_TOOLS: required; accepted: a comma separated list of tool names, or *",
      "  - GATO_MCP_A_URL: required; accepted: an http or https URL",
      "  - A_TOKEN: required; accepted: any text",
      "  - GATO_MCP_B_TOKEN_ENV: must be unset when TRANSPORT is stdio",
      "  - GATO_MCP_B_COMMAND: required; accepted: any text",
      '  - GATO_MCP_C_TRANSPORT: "ws" is not valid; accepted: http, sse, stdio',
      '  - GATO_MCP_C_TOOLS: "," is not valid; accepted: a comma separated list of tool names, or *',
      '  - GATO_MCP_C_URL: "ftp://c.example" is not valid; accepted: an http or https URL',
    ].join("\n"),
  );
});

function serveShop(authorizations: (string | null)[]) {
  const mcp = new McpServer({ name: "shop", version: "1.0.0" });
  mcp.registerTool("lookup", { description: "Find an order" }, () => ({
    content: [{ type: "text", text: "No order" }],
  }));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      authorizations.push(request.headers.get("authorization"));
      return transport.handleRequest(request);
    },
  });
  stops.push(async () => {
    await mcp.close();
    await server.stop(true);
  });
  return mcp
    .connect(transport)
    .then(() => `http://localhost:${server.port}/mcp`);
}

test("connects servers over http with the bearer token", async () => {
  const authorizations: (string | null)[] = [];
  const url = await serveShop(authorizations);
  const servers = await connectMcpServers(
    [
      {
        id: "shop",
        transport: "http",
        url,
        headers: { Authorization: "Bearer secret" },
        permitted: "*",
      },
    ],
    log,
  );
  stops.push(() => servers.close());
  expect(servers.tools.map((tool) => tool.name)).toEqual(["shop_lookup"]);
  expect(
    await servers.tools[0]?.execute({}, new AbortController().signal),
  ).toEqual({ isError: false, output: [{ type: "text", text: "No order" }] });
  expect(new Set(authorizations)).toEqual(new Set(["Bearer secret"]));
});

test("a server that cannot connect or lacks a permitted tool fails startup", async () => {
  const url = await serveShop([]);
  const unreachable = Bun.serve({
    port: 0,
    fetch: () => new Response("no", { status: 401 }),
  });
  stops.push(() => unreachable.stop(true));
  const failure = connectMcpServers(
    [
      { id: "shop", transport: "http", url, permitted: ["refund"] },
      {
        id: "crm",
        transport: "http",
        url: `http://localhost:${unreachable.port}/mcp`,
        permitted: "*",
      },
    ],
    log,
  );
  await expect(failure).rejects.toThrow(
    'MCP servers unavailable:\n  - shop: MCP server "shop" does not offer the permitted tools: refund\n  - crm: Streamable HTTP error: Error POSTing to endpoint: no',
  );
});
