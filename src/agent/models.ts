import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel } from "ai";

export class WorkLimitError extends Error {}

/** Counts every model call of a turn, including summary, preparation, and retries. */
export class Budget {
  private calls = 0;

  constructor(private readonly maxCalls: number) {}

  spend() {
    if (++this.calls > this.maxCalls)
      throw new WorkLimitError(
        `the turn reached its limit of ${this.maxCalls} model calls`,
      );
  }
}

export type ModelFactory = (
  id: string,
  budget: Budget,
) => ReturnType<typeof wrapLanguageModel>;

export function createModels(apiKey: string, baseURL: string): ModelFactory {
  const provider = createOpenRouter({
    apiKey,
    baseURL,
    compatibility: "strict",
  });
  return (id, budget) =>
    wrapLanguageModel({
      model: provider(id),
      middleware: {
        specificationVersion: "v4",
        wrapGenerate: ({ doGenerate }) => {
          budget.spend();
          return doGenerate();
        },
        wrapStream: ({ doStream }) => {
          budget.spend();
          return doStream();
        },
      },
    });
}

/** Fails when the gateway does not list a configured model. */
export async function checkModels(baseURL: string, ids: string[]) {
  const response = await fetch(`${baseURL}/models`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`model gateway answered ${response.status} for /models`);
  const body = (await response.json()) as { data?: { id: string }[] };
  const known = new Set(body.data?.map((model) => model.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length)
    throw new Error(`model gateway does not offer: ${missing.join(", ")}`);
}
