import type { Channel } from "../channels/channel.ts";
import { errorText, log } from "../log.ts";
import type { NoteEntry } from "../record/entries.ts";
import type { Chat } from "../record/store.ts";

/** Saves the note in the chat folder and also on the channel when it has internal notes. */
export async function addNote(
  chat: Chat,
  channel: Channel,
  note: Omit<NoteEntry, "type" | "id" | "at">,
) {
  await chat.add({ type: "note", at: new Date().toISOString(), ...note });
  if (!channel.addNote) return;
  try {
    await channel.addNote(chat.id, `${note.kind}: ${note.text}`);
  } catch (error) {
    log.warn("note.channel_failed", {
      conversation: chat.id,
      kind: note.kind,
      error: errorText(error),
    });
  }
}

/** The error path uses no model call and no agent tool. */
export async function handOffAfterError(
  chat: Chat,
  channel: Channel,
  turn: string,
  explanation: string,
) {
  await addNote(chat, channel, {
    author: "harness",
    kind: "error",
    text: explanation,
    turn,
  });
  log.error("turn.error_handoff", {
    conversation: chat.id,
    turn,
    channelHandoff: channel.handOff !== undefined,
  });
  try {
    await channel.handOff?.(chat.id, "error");
  } catch (error) {
    log.error("handoff.report_failed", {
      conversation: chat.id,
      turn,
      error: errorText(error),
    });
  }
}
