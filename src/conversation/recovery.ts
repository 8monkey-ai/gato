import type { Channel } from "../channels/channel.ts";
import { log } from "../log.ts";
import { addNote } from "./notes.ts";
import { messages } from "./record.ts";
import type { Conversation } from "./store.ts";
import { logFields, save } from "./store.ts";

async function recoverOne(conversation: Conversation, channel: Channel) {
  const fields = logFields(conversation);
  for (const entry of messages(conversation.entries)) {
    if (entry.delivery !== "sending") continue;
    entry.delivery = "uncertain";
    log("warn", "delivery.uncertain_after_restart", {
      ...fields,
      message: entry.id,
    });
  }
  if (conversation.state.activeTurn) {
    const turn = conversation.state.activeTurn;
    conversation.state.activeTurn = undefined;
    await addNote(conversation, channel, {
      type: "outcome",
      text: "Turn interrupted: the harness restarted.",
      turn,
    });
  }
  await save(conversation);
}

export async function recover(
  conversations: Conversation[],
  channelOf: (conversation: Conversation) => Channel | undefined,
  resume: (conversation: Conversation) => void,
) {
  for (const conversation of conversations) {
    const channel = channelOf(conversation);
    if (!channel) continue;
    const unfinished =
      conversation.state.activeTurn !== undefined ||
      messages(conversation.entries).some(
        (entry) => entry.delivery === "sending",
      );
    if (unfinished) await recoverOne(conversation, channel);
    resume(conversation);
  }
}
