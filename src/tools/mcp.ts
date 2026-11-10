import { createMCPClient } from "@ai-sdk/mcp";
import { dynamicTool, jsonSchema, type JSONSchema7, type ToolSet } from "ai";
import { z } from "zod";

import { type Env, envList } from "../env.ts";
import { protectSecret } from "../log.ts";

export type OpenTools = { tools: ToolSet; close(): Promise<void> };

export type McpServer = {
  name: string;
  url: string;
  headers: Record<string, string>;
  tools: string[];
};

export type ToolScope = (tool: { name: string; inputSchema: JSONSchema7 }) => {
  inputSchema: JSONSchema7;
  prepare(input: Record<string, unknown>): Record<string, unknown>;
};

const unscoped: ToolScope = ({ inputSchema }) => ({
  inputSchema,
  prepare: (input) => input,
});

export function mcpServersFromEnv(env: Env): McpServer[] {
  const names = envList(env.MCP_SERVERS);
  if (new Set(names).size !== names.length)
    throw new Error("MCP_SERVERS has a name more than once");
  return names.map((name) => {
    const prefix = `MCP_${name.toUpperCase()}`;
    const url = env[`${prefix}_URL`];
    if (!url || !URL.canParse(url))
      throw new Error(`${prefix}_URL must be a URL`);
    if (!/^[a-z][a-z0-9]*$/.test(name) || name === "respondio") {
      throw new Error(
        `MCP server name "${name}" must be a letter and then letters and digits, and not "respondio"`,
      );
    }
    const headers = parseHeaders(env[`${prefix}_HEADERS`], `${prefix}_HEADERS`);
    return { name, url, headers, tools: envList(env[`${prefix}_TOOLS`]) };
  });
}

function parseHeaders(
  value: string | undefined,
  variable: string,
): Record<string, string> {
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  const headers = z.record(z.string(), z.string()).safeParse(parsed);
  if (!headers.success)
    throw new Error(
      `${variable} must be a JSON object of header names and text values`,
    );
  for (const secret of Object.values(headers.data)) protectSecret(secret);
  return headers.data;
}

export async function connectMcp(
  server: McpServer,
  scope = unscoped,
): Promise<OpenTools> {
  const client = await createMCPClient({
    transport: {
      type: "http",
      url: server.url,
      headers: server.headers,
    },
    initializationOptions: { timeout: 15_000 },
  });
  try {
    const { tools: offered } = await client.listTools({
      options: { timeout: 15_000 },
    });
    const missing = server.tools.filter(
      (name) => !offered.some((tool) => tool.name === name),
    );
    if (missing.length) {
      throw new Error(
        `MCP server "${server.name}" has no tools ${missing.join(", ")}`,
      );
    }
    const tools: ToolSet = {};
    for (const offer of offered.filter((tool) =>
      server.tools.includes(tool.name),
    )) {
      tools[`${server.name}__${offer.name}`] = toTool(client, offer, scope);
    }
    return { tools, close: () => client.close() };
  } catch (error) {
    await client.close();
    throw error;
  }
}

type Client = Awaited<ReturnType<typeof createMCPClient>>;
type Offer = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

function toTool(client: Client, offer: Offer, scope: ToolScope) {
  const scoped = scope({
    name: offer.name,
    inputSchema: offer.inputSchema as JSONSchema7,
  });
  return dynamicTool({
    description: offer.description,
    inputSchema: jsonSchema(scoped.inputSchema),
    execute: async (input, { abortSignal }) => {
      const result = await client.callTool({
        name: offer.name,
        arguments: scoped.prepare((input ?? {}) as Record<string, unknown>),
        options: { signal: abortSignal },
      });
      return { isError: result.isError ?? false, content: result.content };
    },
  });
}
