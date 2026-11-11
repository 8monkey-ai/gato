import { createMCPClient } from "@ai-sdk/mcp";
import { dynamicTool, jsonSchema, type JSONSchema7, type ToolSet } from "ai";

import { type Env, envList } from "../env.ts";
import { protectSecret } from "../log.ts";

export type OpenTools = { tools: ToolSet; close(): Promise<void> };

export type McpServer = {
  name: string;
  url: string;
  bearerToken?: string;
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
    if (!/^[a-z0-9]+$/.test(name) || name === "respondio") {
      throw new Error(
        `MCP server name "${name}" must be letters and digits, and not "respondio"`,
      );
    }
    const bearerToken = env[`${prefix}_BEARER_TOKEN`];
    protectSecret(bearerToken);
    return { name, url, bearerToken, tools: envList(env[`${prefix}_TOOLS`]) };
  });
}

export async function connectMcp(
  server: McpServer,
  scope = unscoped,
): Promise<OpenTools> {
  const client = await createMCPClient({
    transport: {
      type: "http",
      url: server.url,
      headers: server.bearerToken
        ? { authorization: `Bearer ${server.bearerToken}` }
        : undefined,
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
      tools[offer.name] = toTool(client, offer, scope);
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
