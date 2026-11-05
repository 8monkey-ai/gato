import type { Channel } from "../channels/channel.ts";
import { errorText, log } from "../log.ts";
import type { NoteType } from "./entry.ts";
import { addNote } from "./notes.ts";
import type { Conversation } from "./store.ts";
import { save } from "./store.ts";

export type HandoffKind = "out-of-scope" | "error" | "expired";

export interface HandoffRequest {
  kind: HandoffKind;
  reason: string;
  turn?: string;
  byAgent?: boolean;
}

const noteTypes: Record<HandoffKind, NoteType> = {
  "out-of-scope": "handoff",
  error: "error",
  expired: "expired",
};

async function applyLabels(
  conversation: Conversation,
  channel: Channel,
  labels: string[],
) {
  if (channel.labels) {
    await channel.labels.add(conversation.chat, labels);
    return;
  }
  conversation.state.labels = [
    ...new Set([...conversation.state.labels, ...labels]),
  ];
}

async function notify(
  conversation: Conversation,
  channel: Channel,
  text: string,
) {
  if (channel.notifyOperators) {
    await channel.notifyOperators(conversation.chat, text);
    return;
  }
  if (!channel.nativeAssignment) {
    log("warn", "operator.attention_needed", {
      connection: conversation.connection,
      chat: conversation.chat,
    });
  }
}

async function report(
  step: string,
  conversation: Conversation,
  action: () => Promise<void>,
) {
  try {
    await action();
  } catch (error) {
    log("error", "handoff.report_failed", {
      connection: conversation.connection,
      chat: conversation.chat,
      step,
      error: errorText(error),
    });
  }
}

export async function handoff(
  conversation: Conversation,
  channel: Channel,
  request: HandoffRequest,
) {
  const { kind, reason, turn, byAgent } = request;
  await addNote(conversation, channel, {
    type: noteTypes[kind],
    text: reason,
    turn,
    byAgent,
  });
  await report("labels", conversation, () =>
    applyLabels(conversation, channel, ["handoff", kind]),
  );
  await report("notify", conversation, () =>
    notify(conversation, channel, `Handoff requested (${kind}): ${reason}`),
  );
  if (!channel.nativeAssignment) conversation.state.assignee = "human";
  await save(conversation);
  log("info", "handoff.requested", {
    connection: conversation.connection,
    chat: conversation.chat,
    kind,
  });
}
