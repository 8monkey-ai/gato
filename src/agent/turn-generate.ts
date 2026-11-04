import {
  type FinishReason,
  isStepCount,
  type LanguageModel,
  type ModelMessage,
  streamText,
  type ToolSet,
} from "ai";

import type { TurnBudget } from "./budget.ts";

type Input = {
  model: LanguageModel;
  instructions: string;
  messages: ModelMessage[];
  tools: ToolSet;
  budget: TurnBudget;
  push(delta: string): void;
};

export type Generation = { wroteText: boolean; limitReached: boolean };

const asError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

// Each step is one model call. The step limit keeps the generation within the remaining budget.
export async function generate(input: Input): Promise<Generation> {
  const { budget } = input;
  const stepLimit = budget.remainingCalls();
  if (stepLimit < 1) budget.take(); // throws BudgetExceededError
  const result = streamText({
    model: input.model,
    instructions: input.instructions,
    messages: input.messages,
    tools: input.tools,
    maxRetries: 0,
    abortSignal: budget.signal,
    stopWhen: isStepCount(stepLimit),
    // The loop below handles error parts; the default handler would print them.
    onError: () => {},
  });
  let wroteText = false;
  let steps = 0;
  let finish: FinishReason | undefined;
  for await (const part of result.stream) {
    if (part.type === "start-step") {
      budget.take();
      steps++;
    } else if (part.type === "text-delta") {
      wroteText ||= part.text.trim() !== "";
      input.push(part.text);
    } else if (part.type === "finish-step") finish = part.finishReason;
    else if (part.type === "error") throw asError(part.error);
  }
  budget.signal.throwIfAborted();
  return {
    wroteText,
    limitReached: steps >= stepLimit && finish === "tool-calls",
  };
}
