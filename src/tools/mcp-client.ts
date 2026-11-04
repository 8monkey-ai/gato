import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { Logger } from "../log.ts";
import type { ToolOutcome } from "./tool.ts";

export type McpConnectionConfig = { id: string } & (
  | { transport: "http" | "sse"; url: string; headers?: Record<string, string> }
  | { transport: "stdio"; command: string; args?: string[] }
);

export type McpToolInfo = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpClient = {
  tools(): Promise<McpToolInfo[]>;
  call(name: string, args: unknown, signal: AbortSignal): Promise<ToolOutcome>;
  close(): Promise<void>;
};

export function connectMcp(
  config: McpConnectionConfig,
  log: Logger,
): Promise<McpClient> {
  return connectWithTransport(config.id, createTransport(config), log);
}

function createTransport(config: McpConnectionConfig): Transport {
  if (config.transport === "stdio")
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
    });
  const options = { requestInit: { headers: config.headers } };
  const url = new URL(config.url);
  return config.transport === "sse"
    ? new SSEClientTransport(url, options)
    : new StreamableHTTPClientTransport(url, options);
}

export async function connectWithTransport(
  id: string,
  transport: Transport,
  log: Logger,
): Promise<McpClient> {
  const client = new Client({ name: "gato", version: "0.1.0" });
  const serverLog = log.child({ mcpServer: id });
  client.onerror = (error) => serverLog.warn("mcp_error", { error });
  await client.connect(transport);
  serverLog.info("mcp_connected");
  return {
    tools: () => listAllTools(client),
    call: (name, args, signal) =>
      callTool(client, name, args, signal).then((outcome) => {
        if (outcome.isError) serverLog.warn("mcp_tool_failed", { tool: name });
        return outcome;
      }),
    close: () => client.close(),
  };
}

async function listAllTools(client: Client): Promise<McpToolInfo[]> {
  const tools: McpToolInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    for (const tool of page.tools)
      tools.push({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
      });
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

async function callTool(
  client: Client,
  name: string,
  args: unknown,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  if (typeof args !== "object" || args === null || Array.isArray(args))
    return { isError: true, output: "Tool input must be a JSON object" };
  try {
    const result = await client.callTool(
      { name, arguments: args as Record<string, unknown> },
      undefined,
      { signal },
    );
    if (!("content" in result))
      return { isError: false, output: result.toolResult };
    if (result.isError) return { isError: true, output: result.content };
    return {
      isError: false,
      output: result.structuredContent ?? result.content,
    };
  } catch (error) {
    return {
      isError: true,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}
