import type { ToolSet } from "ai";

import type { Settings } from "../config/settings.ts";
import type { MessageEntry } from "../conversation/entry.ts";
import type { Conversation } from "../conversation/store.ts";
import type { ContentPart } from "./context.ts";
import { toModelMessages } from "./context.ts";
import { composeInstructions, today } from "./instructions.ts";
import type { Budget, TurnContext } from "./runner.ts";

export interface PrepareDeps {
  settings: Settings;
  retrieve(conversation: Conversation): Promise<void>;
  tools(conversation: Conversation, turn: string): Promise<ToolSet>;
}

function renderText(entry: MessageEntry): ContentPart[] {
  return [{ type: "text", text: entry.text ?? "" }];
}

export function createPreparer(deps: PrepareDeps) {
  return async (
    conversation: Conversation,
    turn: string,
    _budget: Budget,
  ): Promise<TurnContext> => {
    await deps.retrieve(conversation);
    const instructions = composeInstructions({
      repository: "",
      skills: [],
      today: today(deps.settings.timezone),
      timezone: deps.settings.timezone,
      profile: conversation.state.profile,
    });
    const messages = toModelMessages(conversation.entries, {
      turn,
      includeTools: true,
      render: renderText,
    });
    return {
      instructions,
      messages,
      tools: await deps.tools(conversation, turn),
    };
  };
}
