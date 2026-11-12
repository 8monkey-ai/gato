import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

type ToolSpec = {
  description: string;
  input: Record<string, z.ZodType>;
  result?: (args: Record<string, unknown>) => {
    text: string;
    structured?: Record<string, unknown>;
    isError?: boolean;
  };
};

export function startFakeMcp(
  tools: Record<string, ToolSpec>,
  bearerToken = "mcp-secret",
) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const authorizations: (string | null)[] = [];
  const build = () => {
    const server = new McpServer({ name: "fake", version: "1.0.0" });
    for (const [name, spec] of Object.entries(tools)) {
      server.registerTool(
        name,
        { description: spec.description, inputSchema: spec.input },
        (args) => {
          calls.push({ name, args });
          const result = spec.result?.(args) ?? { text: `${name} done` };
          return {
            content: [{ type: "text", text: result.text }],
            structuredContent: result.structured,
            isError: result.isError,
          };
        },
      );
    }
    return server;
  };
  const http = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      authorizations.push(request.headers.get("authorization"));
      if (request.headers.get("authorization") !== `Bearer ${bearerToken}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await build().connect(transport);
      return transport.handleRequest(request);
    },
  });
  return {
    url: `http://127.0.0.1:${http.port}/mcp`,
    bearerToken,
    calls,
    authorizations,
    stop: () => http.stop(true),
  };
}

export const respondioTools = (): Record<string, ToolSpec> => ({
  get_contact: {
    description: "Get a contact.",
    input: { identifier: z.string() },
    result: (args) => ({
      text: JSON.stringify({
        id: args.identifier,
        firstName: "Ana",
        tags: ["vip"],
      }),
    }),
  },
  update_contact: {
    description: "Update a contact.",
    input: {
      identifier: z.string(),
      firstName: z.string().optional(),
      email: z.string().optional(),
      language: z.string().optional(),
    },
  },
  add_contact_tags: {
    description: "Add tags.",
    input: { identifier: z.string(), tags: z.array(z.string()) },
  },
  create_comment: {
    description: "Add a comment.",
    input: { identifier: z.string(), text: z.string() },
  },
});
