import type { OpenRouterProvider } from "@openrouter/ai-sdk-provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { ToolSet } from "ai";

import { createAfterTurn } from "./agent/after-turn.ts";
import type {
  PreparationModels,
  PreparedCategory,
} from "./agent/attachments.ts";
import { createPreparer } from "./agent/prepare.ts";
import { createTurnRunner } from "./agent/runner.ts";
import type { Channel } from "./channels/channel.ts";
import type { Settings } from "./config/settings.ts";
import { handoff } from "./conversation/handoff.ts";
import { mayAnswer } from "./conversation/ownership.ts";
import { createRetriever } from "./conversation/retrieval.ts";
import type { Conversation } from "./conversation/store.ts";
import { createTurns } from "./conversation/turns.ts";
import type { Skills } from "./skills/catalogue.ts";

export type Channels = Map<string, Channel>;

function preparationModels(settings: Settings, gateway: OpenRouterProvider) {
  const models: PreparationModels = {};
  for (const [category, id] of Object.entries(settings.preparationModels)) {
    if (id) models[category as PreparedCategory] = { id, model: gateway(id) };
  }
  return models;
}

export function createRuntime(
  settings: Settings,
  channels: Channels,
  skills: Skills,
  sharedTools: ToolSet,
) {
  const channelOf = (conversation: Conversation) =>
    channels.get(conversation.connection) as Channel;
  const retrieve = createRetriever(channelOf);
  const eligible = (conversation: Conversation) =>
    mayAnswer(settings.ownershipPolicy, conversation.state);
  const gateway = createOpenRouter(settings.gateway);
  const prepare = createPreparer({
    settings,
    skills,
    retrieve,
    handoff: (conversation, reason, turn) =>
      handoff(conversation, channelOf(conversation), {
        kind: "out-of-scope",
        reason,
        turn,
        byAgent: true,
      }),
    connectionTools: async (conversation) => ({
      ...sharedTools,
      ...(await channelOf(conversation).tools?.(conversation.chat)),
    }),
    preparation: preparationModels(settings, gateway),
    summary: {
      model: gateway(settings.summaryModel ?? settings.model),
      promptFile: settings.summaryPromptFile,
      timezone: settings.timezone,
    },
  });
  const runner = createTurnRunner({
    settings,
    channelOf,
    model: gateway(settings.model),
    prepare,
    afterTurn: createAfterTurn({ channelOf, eligible }),
  });
  return {
    retrieve,
    channelOf,
    eligible,
    turns: createTurns(runner, eligible),
  };
}

export type Runtime = ReturnType<typeof createRuntime>;
