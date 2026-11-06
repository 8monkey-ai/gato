import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { type LanguageModel, wrapLanguageModel } from "ai";

import type { Config } from "../config.ts";

export function createGateway(config: Config["openrouter"]) {
  const provider = createOpenRouter({ ...config, compatibility: "strict" });
  return (modelId: string) => provider(modelId);
}

export async function checkModels(config: Config) {
  const response = await fetch(`${config.openrouter.baseURL}/models`, {
    headers: { authorization: `Bearer ${config.openrouter.apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(
      `OpenRouter model list failed with HTTP ${response.status}`,
    );
  const { data } = (await response.json()) as { data: { id: string }[] };
  const known = new Set(data.map((model) => model.id));
  const { agent, summary, preparation } = config.models;
  const missing = [agent, summary, ...Object.values(preparation)].filter(
    (id): id is string => !!id && !known.has(id),
  );
  if (missing.length)
    throw new Error(
      `OpenRouter does not know these models: ${missing.join(", ")}`,
    );
}

export class WorkLimitError extends Error {}

export function createBudget(
  limits: Config["turn"],
  interruption: AbortSignal,
) {
  const deadline = AbortSignal.timeout(limits.timeoutMs);
  let calls = 0;
  const count = () => {
    if (++calls > limits.maxModelCalls) {
      throw new WorkLimitError(
        `The turn reached its limit of ${limits.maxModelCalls} model calls`,
      );
    }
  };
  return {
    signal: AbortSignal.any([interruption, deadline]),
    timedOut: () => deadline.aborted,
    limit: (model: Exclude<LanguageModel, string>) =>
      wrapLanguageModel({
        model,
        middleware: {
          wrapGenerate: async ({ doGenerate }) => {
            count();
            return doGenerate();
          },
          wrapStream: async ({ doStream }) => {
            count();
            return doStream();
          },
        },
      }),
  };
}

export type Budget = ReturnType<typeof createBudget>;
