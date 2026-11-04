import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

export type ModelProvider = (modelId: string) => LanguageModel;

export function createModelProvider(apiKey: string): ModelProvider {
  // The provider documents "strict" for the OpenRouter API; it also reports stream usage.
  const openrouter = createOpenRouter({ apiKey, compatibility: "strict" });
  return (modelId) => openrouter.chat(modelId);
}
