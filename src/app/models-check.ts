import { z } from "zod";

import { ConfigError } from "../config/env.ts";
import type { Settings } from "../config/settings.ts";
import type { Logger } from "../log.ts";

export type ModelsCheck = "verified" | "unverified" | "not checked";

const modelList = z.object({ data: z.array(z.object({ id: z.string() })) });

async function listOpenRouterModels() {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`OpenRouter model list returned ${response.status}`);
  const { data } = modelList.parse(await response.json());
  return new Set(data.map((model) => model.id));
}

const configuredModels = (settings: Settings) => [
  ...new Set([
    settings.model,
    settings.summaryModel,
    ...Object.values(settings.preparationModels).filter(
      (id) => id !== undefined,
    ),
  ]),
];

// A failed lookup only leaves the models unverified, so an OpenRouter outage does not block startup.
export async function verifyModels(
  settings: Settings,
  log: Logger,
  listModels = listOpenRouterModels,
): Promise<ModelsCheck> {
  let known: Set<string>;
  try {
    known = await listModels();
  } catch (error) {
    log.warn("models.unverified", { error });
    return "unverified";
  }
  const unknown = configuredModels(settings).filter((id) => !known.has(id));
  if (unknown.length > 0)
    throw new ConfigError(
      `Unknown OpenRouter model ids: ${unknown.join(", ")}`,
    );
  return "verified";
}
