import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  authorization: string | null;
}

type Shape = Record<string, z.ZodType>;

/** A fake MCP server over streamable HTTP. Each tool records its calls and answers with the given text. */
export function fakeMcp(
  tools: Record<string, { shape: Shape; answer?: string; error?: string }>,
) {
  const calls: ToolCall[] = [];
  const build = (authorization: string | null) => {
    const server = new McpServer({ name: "fake", version: "1.0.0" });
    for (const [name, tool] of Object.entries(tools))
      server.registerTool(
        name,
        { description: `fake ${name}`, inputSchema: tool.shape },
        (args: Record<string, unknown>) => {
          calls.push({ name, args, authorization });
          const text = tool.error ?? tool.answer ?? "ok";
          return {
            content: [{ type: "text" as const, text }],
            isError: tool.error !== undefined,
          };
        },
      );
    return server;
  };
  const http = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await build(request.headers.get("authorization")).connect(transport);
      return transport.handleRequest(request);
    },
  });
  return {
    url: `http://localhost:${http.port}/mcp`,
    calls,
    stop: () => http.stop(true),
  };
}

/** The tool shapes of the self-hosted respond.io MCP server that the default permissions use. */
export const respondioTools = {
  get_contact: {
    shape: { identifier: z.string() },
    answer: '{"firstName":"Siti"}',
  },
  create_comment: { shape: { identifier: z.string(), text: z.string() } },
  add_contact_tags: {
    shape: { identifier: z.string(), tags: z.array(z.string()) },
  },
  update_contact: {
    shape: {
      identifier: z.string(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      language: z.string().optional(),
    },
  },
  list_contacts: { shape: { search: z.string().optional() } },
};
