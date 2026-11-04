import { ConfigError } from "../config/env.ts";
import type { McpClient, McpToolInfo } from "./mcp-client.ts";
import type { AgentTool } from "./tool.ts";

export type InputTransform = (
  toolName: string,
  input: unknown,
) => { ok: true; input: unknown } | { ok: false; reason: string };

type McpToolOptions = {
  prefix: string;
  permitted: string[] | "*";
  transformInput?: InputTransform;
};

export async function mcpAgentTools(
  client: Pick<McpClient, "tools" | "call">,
  { prefix, permitted, transformInput }: McpToolOptions,
): Promise<AgentTool[]> {
  const offered = await client.tools();
  const selected = selectPermitted(offered, permitted, prefix);
  return selected.map((tool) => ({
    name: `${prefix}_${tool.name}`.replace(/[^A-Za-z0-9_-]/g, "_"),
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: async (input, signal) => {
      const checked = transformInput?.(tool.name, input) ?? {
        ok: true as const,
        input,
      };
      if (!checked.ok)
        return { isError: true, output: `Not permitted: ${checked.reason}` };
      return client.call(tool.name, checked.input, signal);
    },
  }));
}

function selectPermitted(
  offered: McpToolInfo[],
  permitted: string[] | "*",
  prefix: string,
): McpToolInfo[] {
  if (permitted === "*") return offered;
  const byName = new Map(offered.map((tool) => [tool.name, tool]));
  const missing = permitted.filter((name) => !byName.has(name));
  if (missing.length > 0)
    throw new ConfigError(
      `MCP server "${prefix}" does not offer the permitted tools: ${missing.join(", ")}`,
    );
  return permitted.flatMap((name) => byName.get(name) ?? []);
}
