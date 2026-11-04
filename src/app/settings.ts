import path from "node:path";

import { channelType, channelTypeNames } from "../channels/registry.ts";
import { ConfigError, createEnvReader, envId } from "../config/env.ts";
import { readSettings } from "../config/settings.ts";
import { readMcpServers } from "../tools/mcp-servers.ts";

export const connectionPrefix = (id: string) => `GATO_CONNECTION_${envId(id)}_`;

export function readAppConfig(vars: Record<string, string | undefined>) {
  const env = createEnvReader(vars);
  const settings = readSettings(env);
  const accepted = channelTypeNames().join(", ");
  const connections = settings.connections.flatMap(({ id, type }) => {
    // A missing type is already reported by readSettings.
    const channel =
      type === undefined
        ? undefined
        : env.custom(`${connectionPrefix(id)}TYPE`, accepted, channelType);
    return channel ? [{ id, channel }] : [];
  });
  const mcpServers = readMcpServers(env, settings.mcpServers);
  env.assertValid();
  return { env, settings, connections, mcpServers };
}

export async function readSummaryPrompt(file: string | undefined) {
  const target = file ?? path.join(import.meta.dir, "../../prompts/summary.md");
  const prompt = Bun.file(target);
  if (!(await prompt.exists()))
    throw new ConfigError(
      `GATO_SUMMARY_PROMPT_FILE: the file ${target} does not exist`,
    );
  return prompt.text();
}
