import fs from "node:fs/promises";

import type { ModelMessage } from "ai";

import { prepareAttachments } from "../attachments/prepare.ts";
import type { RetrieveAttachments } from "../attachments/retrieve.ts";
import type { ChannelConnection } from "../channels/channel.ts";
import type { Settings } from "../config/settings.ts";
import { type HistoryItem, selectHistory } from "../context/history.ts";
import { toModelMessages } from "../context/model-messages.ts";
import type { Logger } from "../log.ts";
import type { ChatView } from "../record/projection.ts";
import type { AttachmentCategory, ChatRef, Entry } from "../record/types.ts";
import type { Revision } from "../skills/loader.ts";
import type { ChatStore } from "../storage/chat-store.ts";
import { ensureSummary } from "../summary/generate.ts";
import type { TurnBudget } from "./budget.ts";
import type { ModelProvider } from "./models.ts";
import { buildInstructions } from "./prompt.ts";

export type ContextDeps = {
  store: ChatStore;
  provider: ModelProvider;
  settings: Settings;
  summaryPrompt: string;
  retrieveAttachments: RetrieveAttachments;
  now: () => Date;
};

type Input = {
  ref: ChatRef;
  connection: ChannelConnection;
  revision: Revision;
  budget: TurnBudget;
  trigger?: Extract<Entry, { type: "trigger" }>;
  log: Logger;
};

async function summaryOf(deps: ContextDeps, input: Input, view: ChatView) {
  const text = await ensureSummary({
    store: deps.store,
    ref: input.ref,
    view,
    now: deps.now(),
    timeZone: deps.settings.timeZone,
    modelId: deps.settings.summaryModel,
    provider: deps.provider,
    prompt: deps.summaryPrompt,
    budget: input.budget,
    log: input.log,
  });
  if (text === undefined) return undefined;
  const saved = await deps.store.readSummary(input.ref);
  return { generatedAt: saved?.generatedAt ?? deps.now().toISOString(), text };
}

function history(deps: ContextDeps, view: ChatView, input: Input) {
  const { scope, includeToolActivity } = deps.settings.history;
  const items = selectHistory(view, {
    scope,
    includeToolActivity,
    now: deps.now(),
    timeZone: deps.settings.timeZone,
  });
  const { trigger } = input;
  if (!trigger) return items;
  // The current nudge prompt is always the last user message, even when tool activity is omitted.
  const current: HistoryItem = { kind: "trigger", trigger };
  return [
    ...items.filter(
      (item) =>
        item.kind !== "trigger" || item.trigger.turnId !== trigger.turnId,
    ),
    current,
  ];
}

const historyMessages = (items: HistoryItem[]) =>
  items.flatMap((item) => (item.kind === "message" ? [item.message] : []));

async function messagesFor(deps: ContextDeps, input: Input) {
  const { store, settings } = deps;
  await prepareAttachments({
    store,
    ref: input.ref,
    messages: historyMessages(
      history(deps, await store.load(input.ref), input),
    ),
    models: settings.preparationModels,
    provider: deps.provider,
    budget: input.budget,
    log: input.log,
    now: deps.now,
  });
  const prepared = Object.entries(settings.preparationModels).flatMap(
    ([category, model]) => (model ? [category as AttachmentCategory] : []),
  );
  return toModelMessages(history(deps, await store.load(input.ref), input), {
    loadFile: (relative) =>
      fs.readFile(store.attachmentPath(input.ref, relative)),
    preparedCategories: new Set(prepared),
  });
}

// Contact facts help but are not essential, so a failure costs only the facts.
async function contactContext({ connection, ref, log }: Input) {
  try {
    return (await connection.contactContext?.(ref.chatId)) ?? {};
  } catch {
    log.warn("turn.contact_context_failed");
    return {};
  }
}

export async function buildContext(
  deps: ContextDeps,
  input: Input,
): Promise<{ instructions: string; messages: ModelMessage[] }> {
  const { ref, connection, log } = input;
  const { store } = deps;
  const signal = input.budget.signal;
  await deps.retrieveAttachments({ store, ref, connection, log, signal });
  const summary = await summaryOf(deps, input, await store.load(ref));
  const messages = await messagesFor(deps, input);
  const instructions = buildInstructions({
    revision: input.revision,
    country: deps.settings.country,
    now: deps.now(),
    timeZone: deps.settings.timeZone,
    contact: await contactContext(input),
    summary,
  });
  return { instructions, messages };
}
