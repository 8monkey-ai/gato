import { z } from "zod";

import type { AgentTool, ToolOutcome } from "../tools/tool.ts";
import type { Revision } from "./loader.ts";

const input = z.object({ path: z.string() });

export function readSkillTool(revision: Pick<Revision, "read">): AgentTool {
  return {
    name: "read_skill",
    description: [
      "Read a file of a skill from the skill catalogue.",
      'Use "<skill>/SKILL.md" for the skill instructions, for example "refunds/SKILL.md".',
      'Use "<skill>/<path>" for a file that the skill refers to, for example "refunds/references/policy.md".',
      'Each path starts with the skill name. Absolute paths and ".." are not accepted.',
    ].join(" "),
    inputSchema: z.toJSONSchema(input),
    execute: (value) => Promise.resolve(readFile(revision, value)),
  };
}

function readFile(
  revision: Pick<Revision, "read">,
  value: unknown,
): ToolOutcome {
  const parsed = input.safeParse(value);
  if (!parsed.success)
    return { output: 'Input must be { "path": string }.', isError: true };
  const result = revision.read(parsed.data.path);
  return result.ok
    ? { output: result.text, isError: false }
    : { output: result.error, isError: true };
}
