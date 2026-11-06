import { dynamicTool, jsonSchema, type ToolSet } from "ai";

import type { AgentTool } from "../channels/channel.ts";
import { errorText } from "../log.ts";
import type { SkillsRevision } from "../skills/checkout.ts";

export function readSkillTool(skills: SkillsRevision): AgentTool {
  return {
    name: "read_skill",
    description:
      "Read a skill or one of its reference files from the approved skills repository. Give the path from the skill catalogue, or a file path inside a skill folder.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    execute: (input) => Promise.resolve(skills.read(String(input.path))),
  };
}

export function handoffTool(
  handOff: (reason: string) => Promise<void>,
): AgentTool {
  return {
    name: "handoff",
    description:
      "Ask a human colleague to take over this conversation when the skills or knowledge require human help. Give the reason in English. This tool sends nothing to the customer.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
    execute: async (input) => {
      await handOff(String(input.reason));
      return "A human colleague was asked to take over. Tell the customer what the skills say to tell them in this case.";
    },
  };
}

export interface ToolActivity {
  name: string;
  input: unknown;
  output?: unknown;
  error?: string;
}

/** Throws when two tools have the same name, because the model could not tell them apart. */
export function toToolSet(
  tools: AgentTool[],
  record: (activity: ToolActivity) => Promise<void>,
): ToolSet {
  const set: ToolSet = {};
  for (const tool of tools) {
    if (set[tool.name]) throw new Error(`two tools are named "${tool.name}"`);
    set[tool.name] = dynamicTool({
      description: tool.description,
      inputSchema: jsonSchema(tool.parameters),
      execute: async (input, { abortSignal }) => {
        const args = (input ?? {}) as Record<string, unknown>;
        try {
          const output = await tool.execute(
            args,
            abortSignal ?? new AbortController().signal,
          );
          await record({ name: tool.name, input: args, output });
          return output;
        } catch (error) {
          await record({
            name: tool.name,
            input: args,
            error: errorText(error),
          });
          throw error;
        }
      },
    });
  }
  return set;
}
