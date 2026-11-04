import { z } from "zod";

import type { Controls } from "../conversation/controls.ts";
import type { ChatRef } from "../record/types.ts";
import type { AgentTool } from "../tools/tool.ts";

const input = z.object({
  reason: z
    .string()
    .min(1)
    .describe(
      "Why a colleague must take over, in English, for colleagues only.",
    ),
});

export function handoffTool({
  ref,
  turnId,
  controls,
  onHandoff,
}: {
  ref: ChatRef;
  turnId: string;
  controls: Pick<Controls, "handoff">;
  onHandoff: () => void;
}): AgentTool {
  return {
    name: "handoff_to_colleague",
    description:
      "Ask a human colleague to take over this conversation when your skills require human help. This sends nothing to the customer.",
    inputSchema: z.toJSONSchema(input),
    async execute(value) {
      const parsed = input.safeParse(value);
      if (!parsed.success)
        return { output: 'Input must be { "reason": string }.', isError: true };
      await controls.handoff(ref, {
        path: "tool",
        reason: parsed.data.reason,
        turnId,
      });
      onHandoff();
      return {
        output:
          "A colleague has been asked to take over. Follow your skills for any customer-facing wording.",
        isError: false,
      };
    },
  };
}
