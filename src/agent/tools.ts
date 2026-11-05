import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";

import type { Snapshot } from "../skills/catalogue.ts";

interface BuiltinToolOptions {
  snapshot: Snapshot;
  handoff: (reason: string) => Promise<void>;
}

export function builtinTools({
  snapshot,
  handoff,
}: BuiltinToolOptions): ToolSet {
  return {
    read_skill: tool({
      description:
        "Read a skill or a reference file from the approved skills repository. Give the skill path from the skill list, or the path of a file inside a skill folder.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Skill path or file path, for example billing/SKILL.md"),
      }),
      execute: async ({ path }) => await snapshot.read(path),
    }),
    handoff_to_colleague: tool({
      description:
        "Hand the conversation to a human colleague when the knowledge or skill instructions require human help. This does not send a message to the customer.",
      inputSchema: z.object({
        reason: z
          .string()
          .min(1)
          .describe("Why a human must take over, in English"),
      }),
      execute: async ({ reason }) => {
        await handoff(reason);
        return "The handoff is recorded and the operators are informed. A human is not yet confirmed as assigned.";
      },
    }),
  };
}
