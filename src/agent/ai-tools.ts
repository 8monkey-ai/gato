import { dynamicTool, jsonSchema, type JSONSchema7, type ToolSet } from "ai";

import type { AgentTool, ToolOutcome } from "../tools/tool.ts";

export type ToolRecorder = {
  call(callId: string, name: string, input: unknown): Promise<void>;
  result(callId: string, name: string, outcome: ToolOutcome): Promise<void>;
};

async function run(tool: AgentTool, input: unknown, signal: AbortSignal) {
  try {
    return await tool.execute(input, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    const output = error instanceof Error ? error.message : String(error);
    return { output, isError: true };
  }
}

const errorText = (output: unknown) =>
  typeof output === "string" ? output : JSON.stringify(output);

// A thrown error makes the SDK send a tool-error result, so the model sees that the tool failed.
export function toAiTools(tools: AgentTool[], record: ToolRecorder): ToolSet {
  return Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      dynamicTool({
        description: tool.description,
        inputSchema: jsonSchema(tool.inputSchema as JSONSchema7),
        execute: async (input, { toolCallId, abortSignal }) => {
          await record.call(toolCallId, tool.name, input);
          const signal = abortSignal ?? new AbortController().signal;
          const outcome = await run(tool, input, signal);
          await record.result(toolCallId, tool.name, outcome);
          if (outcome.isError) throw new Error(errorText(outcome.output));
          return outcome.output;
        },
      }),
    ]),
  );
}
