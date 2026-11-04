import { handoffToolName } from "../agent/handoff-tool.ts";
import type { ChannelConnection } from "../channels/channel.ts";
import type { Settings } from "../config/settings.ts";
import type { Logger } from "../log.ts";
import { readSkillName } from "../skills/read-tool.ts";
import type { AgentTool } from "../tools/tool.ts";
import { assertUniqueToolNames } from "../tools/toolset.ts";

// Contact tools have the same names for every chat of a connection, so any chat id shows them.
export async function checkToolNames(
  connections: Iterable<ChannelConnection>,
  mcpTools: AgentTool[],
) {
  const shared = [
    { name: readSkillName },
    { name: handoffToolName },
    ...mcpTools,
  ];
  for (const connection of connections)
    assertUniqueToolNames([
      ...shared,
      ...((await connection.contactTools?.("0")) ?? []),
    ]);
}

export function warnUnpreparedCategories(
  models: Settings["preparationModels"],
  log: Logger,
) {
  for (const [category, model] of Object.entries(models))
    if (model === undefined)
      log.warn("attachments.no_preparation_model", {
        category,
        problem: `operator and workflow ${category} attachments will fail turns until GATO_${category.toUpperCase()}_MODEL is set`,
      });
}
