import { envId, type EnvReader, parseList } from "../config/env.ts";
import type { Logger } from "../log.ts";
import { connectMcp, type McpConnectionConfig } from "./mcp-client.ts";
import { mcpAgentTools } from "./mcp-tools.ts";
import type { AgentTool } from "./tool.ts";

export type McpServerConfig = McpConnectionConfig & {
  permitted: string[] | "*";
};

export function readMcpServers(
  env: EnvReader,
  ids: string[],
): McpServerConfig[] {
  return ids.map((id) => readServer(env, id));
}

function readServer(root: EnvReader, id: string): McpServerConfig {
  const env = root.scope(`GATO_MCP_${envId(id)}_`);
  const transport = env.enumOf(
    "TRANSPORT",
    ["http", "sse", "stdio"] as const,
    "http",
  );
  const permitted = env.custom(
    "TOOLS",
    "a comma separated list of tool names, or *",
    parseTools,
  );
  if (transport === "stdio") {
    if (env.optionalString("TOKEN_ENV") !== undefined)
      env.problem("TOKEN_ENV", "must be unset when TRANSPORT is stdio");
    return {
      id,
      transport,
      command: env.string("COMMAND"),
      args: env.list("ARGS", { default: [] }),
      permitted,
    };
  }
  const url = env.custom("URL", "an http or https URL", parseUrl);
  const tokenEnv = env.optionalString("TOKEN_ENV");
  const headers =
    tokenEnv === undefined
      ? undefined
      : { Authorization: `Bearer ${root.string(tokenEnv)}` };
  return { id, transport, url, headers, permitted };
}

function parseTools(raw: string): string[] | "*" | undefined {
  if (raw === "*") return "*";
  const names = parseList(raw);
  return names.length > 0 ? names : undefined;
}

function parseUrl(raw: string): string | undefined {
  const url = URL.parse(raw);
  return url?.protocol === "http:" || url?.protocol === "https:"
    ? raw
    : undefined;
}

export async function connectMcpServers(
  configs: McpServerConfig[],
  log: Logger,
): Promise<{ tools: AgentTool[]; close(): Promise<void> }> {
  const results = await Promise.allSettled(
    configs.map((config) => openServer(config, log)),
  );
  const opened = results.flatMap((r) =>
    r.status === "fulfilled" ? [r.value] : [],
  );
  const close = async () => {
    await Promise.allSettled(opened.map(({ client }) => client.close()));
  };
  const failures = results.flatMap((r, i) =>
    r.status === "rejected"
      ? [`  - ${configs[i]?.id}: ${errorMessage(r.reason)}`]
      : [],
  );
  if (failures.length > 0) {
    await close();
    throw new Error(`MCP servers unavailable:\n${failures.join("\n")}`);
  }
  return { tools: opened.flatMap(({ tools }) => tools), close };
}

async function openServer(config: McpServerConfig, log: Logger) {
  const client = await connectMcp(config, log);
  try {
    const tools = await mcpAgentTools(client, {
      prefix: config.id,
      permitted: config.permitted,
    });
    return { client, tools };
  } catch (error) {
    await client.close();
    throw error;
  }
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
