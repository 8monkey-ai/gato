import { ConfigError } from "../config/env.ts";
import type { AgentTool } from "./tool.ts";

export function assertUniqueToolNames(tools: AgentTool[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const { name } of tools) (seen.has(name) ? duplicates : seen).add(name);
  if (duplicates.size > 0)
    throw new ConfigError(
      `Duplicate tool names: ${[...duplicates].join(", ")}`,
    );
}
