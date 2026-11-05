import type { ModelMessage, ToolSet } from "ai";

import type { Settings } from "../config/settings.ts";
import type { Entry } from "../conversation/entry.ts";
import type { Conversation } from "../conversation/store.ts";
import type { Skills } from "../skills/catalogue.ts";
import { monthBefore, today } from "../time.ts";
import type { PreparationModels } from "./attachments.ts";
import {
  createRenderer,
  loadDirectFiles,
  prepareAttachments,
} from "./attachments.ts";
import { toModelMessages } from "./context.ts";
import { composeInstructions } from "./instructions.ts";
import type { Budget, TurnContext } from "./runner.ts";
import type { Summary, SummaryDeps } from "./summary.ts";
import { summaryForTurn } from "./summary.ts";
import { builtinTools } from "./tools.ts";

interface PrepareDeps {
  settings: Settings;
  skills: Skills;
  summary: SummaryDeps;
  preparation: PreparationModels;
  retrieve: (conversation: Conversation) => Promise<void>;
  handoff: (
    conversation: Conversation,
    reason: string,
    turn: string,
  ) => Promise<void>;
  connectionTools: (conversation: Conversation) => Promise<ToolSet>;
}

function selectHistory(entries: Entry[], settings: Settings) {
  if (!settings.recentContactHistory) return entries;
  const since = monthBefore(new Date(), settings.timezone).toISOString();
  return entries.filter((entry) => entry.at >= since);
}

function summaryMessages(summary: Summary | undefined): ModelMessage[] {
  if (!summary) return [];
  const date = summary.date.toISOString().slice(0, 10);
  const text = `[Private summary of earlier conversations with this customer, written ${date}]\n${summary.text}`;
  return [{ role: "assistant", content: text }];
}

async function conversationMessages(
  deps: PrepareDeps,
  conversation: Conversation,
  turn: string,
  budget: Budget,
) {
  const summary = await summaryForTurn(conversation, deps.summary, budget);
  const entries = selectHistory(conversation.entries, deps.settings);
  await prepareAttachments(conversation, entries, deps.preparation, budget);
  const files = await loadDirectFiles(conversation, entries, deps.preparation);
  const render = createRenderer(files, deps.preparation);
  const includeTools = deps.settings.includeToolActivity;
  return [
    ...summaryMessages(summary),
    ...toModelMessages(entries, { turn, includeTools, render }),
  ];
}

export function createPreparer(deps: PrepareDeps) {
  return async (
    conversation: Conversation,
    turn: string,
    budget: Budget,
  ): Promise<TurnContext> => {
    const snapshot = await deps.skills.current();
    await deps.retrieve(conversation);
    const instructions = composeInstructions({
      repository: snapshot.instructions,
      skills: snapshot.skills,
      today: today(deps.settings.timezone),
      timezone: deps.settings.timezone,
      profile: conversation.state.profile,
    });
    const messages = await conversationMessages(
      deps,
      conversation,
      turn,
      budget,
    );
    const builtin = builtinTools({
      snapshot,
      handoff: (reason) => deps.handoff(conversation, reason, turn),
    });
    return {
      instructions,
      messages,
      tools: { ...(await deps.connectionTools(conversation)), ...builtin },
    };
  };
}
