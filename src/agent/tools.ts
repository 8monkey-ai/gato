import { tool, type ToolSet } from "ai";
import { z } from "zod";

import type { Connection } from "../channels/channel.ts";
import { log } from "../log.ts";
import type { Conversation } from "../record/store.ts";
import { type Instructions, readSkill } from "../skills/skills.ts";
import { connectMcp, type McpServer, type OpenTools } from "../tools/mcp.ts";
import type { Prompts } from "./prompts.ts";

type Options = {
  instructions: Instructions;
  prompts: Prompts;
  conversation: Conversation;
  connection: Connection;
  mcpServers: readonly McpServer[];
};

export async function openTools(options: Options): Promise<OpenTools> {
  const { connection, conversation } = options;
  const external = await Promise.all([
    ...options.mcpServers.map((server) =>
      optional(server.name, () => connectMcp(server)),
    ),
    ...(connection.contactTools
      ? [
          optional(connection.id, () =>
            connection.contactTools!(conversation.contact),
          ),
        ]
      : []),
  ]);
  const opened = external.filter((tools) => tools !== undefined);
  const close = async () => {
    await Promise.all(opened.map((t) => t.close()));
  };
  try {
    return {
      tools: merge([...opened.map((t) => t.tools), builtinTools(options)]),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function merge(toolSets: ToolSet[]): ToolSet {
  const merged: ToolSet = {};
  for (const [name, tool] of toolSets.flatMap((set) => Object.entries(set))) {
    if (name in merged)
      throw new Error(`More than one tool is named "${name}"`);
    merged[name] = tool;
  }
  return merged;
}

async function optional(name: string, open: () => Promise<OpenTools>) {
  try {
    return await open();
  } catch (error) {
    log.error("tools.unavailable", { server: name, error });
    return undefined;
  }
}

function builtinTools({
  instructions,
  prompts,
  connection,
  conversation,
}: Options): ToolSet {
  const tools: ToolSet = {
    read_skill: tool({
      description: prompts["tool-read-skill"],
      inputSchema: z.object({ skill: z.string(), file: z.string().optional() }),
      execute: ({ skill, file }) => readSkill(instructions, skill, file),
    }),
  };
  const handoff = connection.handoff?.bind(connection);
  if (handoff) {
    tools.handoff_to_colleague = tool({
      description: prompts["tool-handoff"],
      inputSchema: z.object({ reason: z.string().min(1) }),
      execute: async ({ reason }) => {
        await conversation.lock(async (edit) => {
          edit.add({
            kind: "note",
            author: "agent",
            at: new Date().toISOString(),
            text: `Handoff: ${reason}`,
          });
          await edit.save();
        });
        await handoff(conversation.contact, reason, "out-of-scope");
        return "A human colleague was asked to take over.";
      },
    });
  }
  return tools;
}
