import type { Channel } from "../channels/channel.ts";
import { handoff } from "../conversation/handoff.ts";
import { addNote } from "../conversation/notes.ts";
import type { Conversation } from "../conversation/store.ts";
import type { TurnKind } from "../conversation/turns.ts";
import type { TurnResult } from "./reply.ts";

interface AfterTurnDeps {
  channelOf: (conversation: Conversation) => Channel;
  eligible: (conversation: Conversation) => boolean;
}

function unrecoverable(result: TurnResult) {
  return (
    (result.outcome === "failed" && !result.uncertain) ||
    result.outcome === "timed-out"
  );
}

export function createAfterTurn(deps: AfterTurnDeps) {
  return async (
    conversation: Conversation,
    kind: TurnKind,
    result: TurnResult,
    turn: string,
  ) => {
    if (!unrecoverable(result)) return;
    const channel = deps.channelOf(conversation);
    const reason = `The agent could not answer (${result.outcome}): ${result.reason ?? "unknown cause"}`;
    if (kind === "nudge") {
      await addNote(conversation, channel, {
        type: "nudge-failed",
        text: `Nudge failed. ${reason}`,
        turn,
      });
      return;
    }
    if (!deps.eligible(conversation)) return;
    await handoff(conversation, channel, { kind: "error", reason, turn });
  };
}
