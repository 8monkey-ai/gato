import type { ToolSet } from "ai";

import type { Settings } from "../config/settings.ts";
import type { Conversation } from "../conversation/store.ts";
import type { Skills } from "../skills/catalogue.ts";
import type { PreparationModels } from "./attachments.ts";
import {
  createRenderer,
  loadDirectFiles,
  prepareAttachments,
} from "./attachments.ts";
import { toModelMessages } from "./context.ts";
import { composeInstructions, today } from "./instructions.ts";
import type { Budget, TurnContext } from "./runner.ts";
import { builtinTools } from "./tools.ts";

export interface PrepareDeps {
  settings: Settings;
  skills: Skills;
  retrieve: (conversation: Conversation) => Promise<void>;
  handoff: (
    conversation: Conversation,
    reason: string,
    turn: string,
  ) => Promise<void>;
  connectionTools: (conversation: Conversation) => Promise<ToolSet>;
  preparation: PreparationModels;
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
    const entries = conversation.entries;
    await prepareAttachments(conversation, entries, deps.preparation, budget);
    const files = await loadDirectFiles(
      conversation,
      entries,
      deps.preparation,
    );
    const render = createRenderer(files, deps.preparation);
    const messages = toModelMessages(entries, {
      turn,
      includeTools: true,
      render,
    });
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
