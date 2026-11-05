import type { LanguageModel, ModelMessage, TextStreamPart, ToolSet } from "ai";
import { isStepCount, streamText } from "ai";

import type { EntryInput } from "../conversation/entry.ts";

interface GenerateOptions {
  model: LanguageModel;
  instructions: string;
  messages: ModelMessage[];
  tools: ToolSet;
  maxSteps: number;
  signal: AbortSignal;
  onText: (text: string) => void;
  onStepEnd: () => void;
  record: (entry: EntryInput) => Promise<void>;
}

function toolEntry(part: TextStreamPart<ToolSet>): EntryInput | undefined {
  if (part.type === "tool-call") {
    return {
      kind: "tool-call",
      callId: part.toolCallId,
      tool: part.toolName,
      input: part.input as unknown,
    };
  }
  if (part.type === "tool-result") {
    return {
      kind: "tool-result",
      callId: part.toolCallId,
      tool: part.toolName,
      output: part.output as unknown,
    };
  }
  if (part.type === "tool-error") {
    const message =
      part.error instanceof Error ? part.error.message : String(part.error);
    return {
      kind: "tool-result",
      callId: part.toolCallId,
      tool: part.toolName,
      output: message,
      error: true,
    };
  }
  return undefined;
}

export async function generate(options: GenerateOptions) {
  const result = streamText({
    model: options.model,
    instructions: options.instructions,
    messages: options.messages,
    tools: options.tools,
    stopWhen: isStepCount(options.maxSteps),
    abortSignal: options.signal,
    maxRetries: 0,
    // The stream reports errors; the default handler prints request bodies with customer data.
    onError: () => undefined,
  });
  for await (const part of result.stream) {
    if (part.type === "text-delta") options.onText(part.text);
    else if (part.type === "finish-step") options.onStepEnd();
    else if (part.type === "error") throw part.error;
    const entry = toolEntry(part);
    if (entry) await options.record(entry);
  }
  options.signal.throwIfAborted();
  return await result.finishReason;
}
