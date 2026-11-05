import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

export interface FakeTool {
  name: string;
  input: Record<string, z.ZodType>;
  result?: (args: Record<string, unknown>) => {
    text: string;
    isError?: boolean;
  };
}

export interface McpCall {
  name: string;
  args: Record<string, unknown>;
  authorization: string | null;
}

const text = z.string();

export const respondTools: FakeTool[] = [
  { name: "get_contact", input: { identifier: text } },
  { name: "create_comment", input: { identifier: text, text } },
  {
    name: "add_contact_tags",
    input: { identifier: text, tags: z.array(text) },
  },
  {
    name: "update_contact",
    input: {
      identifier: text,
      firstName: text.optional(),
      lastName: text.optional(),
      language: text.optional(),
      email: text.optional(),
    },
  },
  {
    name: "update_conversation_status",
    input: { identifier: text, status: text },
  },
  { name: "list_contacts", input: { search: text.optional() } },
  { name: "send_message", input: { identifier: text, text } },
];

export class FakeMcp {
  readonly calls: McpCall[] = [];
  private readonly server = Bun.serve({
    port: 0,
    fetch: (request) => this.handle(request),
  });

  constructor(private readonly tools: FakeTool[]) {}

  get url() {
    return `http://localhost:${this.server.port}/mcp`;
  }

  async stop() {
    await this.server.stop(true);
  }

  private build(authorization: string | null) {
    const server = new McpServer({ name: "fake", version: "1.0.0" });
    for (const tool of this.tools) {
      server.registerTool(
        tool.name,
        { description: `Fake ${tool.name}`, inputSchema: tool.input },
        (args: Record<string, unknown>) => {
          this.calls.push({ name: tool.name, args, authorization });
          const result = tool.result?.(args) ?? { text: `${tool.name} ok` };
          return {
            content: [{ type: "text" as const, text: result.text }],
            isError: result.isError,
          };
        },
      );
    }
    return server;
  }

  private async handle(request: Request) {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await this.build(request.headers.get("authorization")).connect(transport);
    return await transport.handleRequest(request);
  }
}
