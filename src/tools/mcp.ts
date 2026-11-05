import type { MCPClient } from "@ai-sdk/mcp";
import { createMCPClient } from "@ai-sdk/mcp";
import { dynamicTool, jsonSchema } from "ai";

import { errorText } from "../log.ts";

export interface McpServerConfig {
  label: string;
  url: string;
  token?: string;
  permitted: string[];
}

export interface ObjectSchema {
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: ObjectSchema;
}

interface CallResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
}

function resultValue(name: string, result: CallResult) {
  const text = (result.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  if (result.isError)
    throw new Error(`The tool ${name} failed: ${text || "no details"}`);
  return result.structuredContent ?? text;
}

export async function connectMcp(config: McpServerConfig) {
  const headers = config.token
    ? { Authorization: `Bearer ${config.token}` }
    : undefined;
  let client: MCPClient | undefined;
  const open = async () =>
    (client ??= await createMCPClient({
      transport: { type: "http", url: config.url, headers },
    }));
  const { tools } = await (await open()).listTools();
  const missing = config.permitted.filter(
    (name) => !tools.some((tool) => tool.name === name),
  );
  if (missing.length > 0)
    throw new Error(
      `${config.label} does not offer the permitted tools: ${missing.join(", ")}.`,
    );
  const definitions = tools.filter((tool) =>
    config.permitted.includes(tool.name),
  ) as McpToolDefinition[];

  async function call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    let result: CallResult;
    try {
      const connected = await open();
      result = (await connected.callTool({
        name,
        arguments: args,
        options: { signal, timeout: 30_000 },
      })) as CallResult;
    } catch (error) {
      await client?.close().catch(() => undefined);
      client = undefined;
      throw new Error(`The tool ${name} is unavailable: ${errorText(error)}`, {
        cause: error,
      });
    }
    return resultValue(name, result);
  }

  return { definitions, call, close: async () => await client?.close() };
}

export type McpConnection = Awaited<ReturnType<typeof connectMcp>>;

export interface ToolOptions {
  description?: string;
  inputSchema: ObjectSchema;
  execute: (
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

export function mcpTool(options: ToolOptions) {
  return dynamicTool({
    description: options.description,
    inputSchema: jsonSchema(
      options.inputSchema as Parameters<typeof jsonSchema>[0],
    ),
    execute: (input, { abortSignal }) =>
      options.execute((input ?? {}) as Record<string, unknown>, abortSignal),
  });
}
