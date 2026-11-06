import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { AgentTool } from "../channels/channel.ts";

interface McpServerTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function resultValue(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((part: { type: string; text?: string }) =>
      part.type === "text" ? part.text : `[${part.type} content]`,
    )
    .join("\n");
  if (result.isError) throw new Error(text || "the tool reported an error");
  return result.structuredContent ?? text;
}

/** One HTTP connection to an MCP server. Only permitted tools are exposed. */
export class McpConnection {
  private constructor(
    readonly server: string,
    private readonly client: Client,
    readonly tools: McpServerTool[],
  ) {}

  static async connect(options: {
    server: string;
    url: string;
    headers: Record<string, string>;
    permitted: string[];
  }): Promise<McpConnection> {
    const client = new Client({ name: "gato", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: { headers: options.headers },
    });
    await client.connect(transport, { timeout: 15_000 });
    const { tools } = await client.listTools(undefined, { timeout: 15_000 });
    const missing = options.permitted.filter(
      (name) => !tools.some((t) => t.name === name),
    );
    if (missing.length)
      throw new Error(
        `MCP server ${options.server} does not offer the permitted tools: ${missing.join(", ")}`,
      );
    const permitted = tools
      .filter((tool) => options.permitted.includes(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? tool.name,
        inputSchema: tool.inputSchema,
      }));
    return new McpConnection(options.server, client, permitted);
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      {
        signal,
        timeout: 60_000,
      },
    );
    return resultValue(result);
  }

  close(): Promise<void> {
    return this.client.close();
  }

  /** Tool names carry the server name, so names from different servers cannot collide. */
  agentTools(): AgentTool[] {
    return this.tools.map((tool) => ({
      name: `${this.server}_${tool.name}`,
      description: tool.description,
      parameters: tool.inputSchema,
      execute: (input, signal) => this.call(tool.name, input, signal),
    }));
  }
}
