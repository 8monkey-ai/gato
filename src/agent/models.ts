import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { type LanguageModel, wrapLanguageModel } from "ai";

import type { Config } from "../config.ts";
import { log } from "../log.ts";

export function createGateway(config: Config["openrouter"]) {
  const provider = createOpenRouter({ ...config, compatibility: "strict" });
  return (modelId: string) => provider(modelId);
}

export async function checkModels(config: Config) {
  const url = `${config.openrouter.baseURL}/models`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${config.openrouter.apiKey}` },
    signal: AbortSignal.timeout(15_000),
  }).catch((error: unknown) => {
    throw new Error(
      `The model gateway ${url} cannot be reached: ${String(error)}`,
    );
  });
  if (!response.ok)
    throw new Error(
      `The model gateway ${url} answered HTTP ${response.status}`,
    );
  const { data } = (await response.json()) as { data: { id: string }[] };
  const known = new Set(data.map((model) => model.id));
  const { agent, summary, preparation } = config.models;
  const configured = new Set([agent, summary, ...Object.values(preparation)]);
  const missing = [...configured].filter(
    (id): id is string => !!id && !known.has(id),
  );
  // Gateways can resolve their own model names, for example agent aliases, only when they are called.
  if (missing.length) log.warn("models.not_listed", { models: missing });
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
