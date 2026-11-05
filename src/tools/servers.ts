import type { ToolSet } from "ai";

import type { Env } from "../config/env.ts";
import { ConfigError } from "../config/env.ts";
import type { McpConnection } from "./mcp.ts";
import { connectMcp, mcpTool } from "./mcp.ts";

const toolPrefix = /^[a-z0-9]+(_[a-z0-9]+)*$/;

export function readMcpServers(env: Env, reserved: string[]) {
  return env.list("MCP_SERVERS").map((name) => {
    if (reserved.includes(name)) {
      throw new ConfigError(
        `MCP server "${name}" has the name of a channel connection. Use another name.`,
      );
    }
    if (!toolPrefix.test(name)) {
      throw new ConfigError(
        `Invalid MCP server name "${name}". Use lowercase letters and digits, joined by single "_".`,
      );
    }
    const scoped = env.scoped(`MCP_${name.toUpperCase()}_`);
    const permitted = scoped.list("TOOLS");
    if (permitted.length === 0)
      throw new ConfigError(
        `Missing ${scoped.name("TOOLS")}. List the permitted tools.`,
      );
    return {
      name,
      label: `MCP server "${name}"`,
      url: scoped.string("URL"),
      token: scoped.optional("TOKEN"),
      permitted,
    };
  });
}

function toolSetOf(prefix: string, connection: McpConnection): ToolSet {
  const entries = connection.definitions.map((definition) => [
    `${prefix}__${definition.name}`,
    mcpTool({
      description: definition.description,
      inputSchema: definition.inputSchema,
      execute: (args, signal) => connection.call(definition.name, args, signal),
    }),
  ]);
  return Object.fromEntries(entries) as ToolSet;
}

export async function connectServers(
  configs: ReturnType<typeof readMcpServers>,
) {
  const sets = await Promise.all(
    configs.map(async (config) =>
      toolSetOf(config.name, await connectMcp(config)),
    ),
  );
  return Object.assign({}, ...sets) as ToolSet;
}
