import type { Channel } from "../channels/channel.ts";
import { errorText, log } from "../log.ts";
import type { NoteType } from "./entry.ts";
import { insertEntry } from "./record.ts";
import type { Conversation } from "./store.ts";
import { logFields, save } from "./store.ts";

interface Note {
  type: NoteType;
  text: string;
  turn?: string;
  byAgent?: boolean;
}

const nativeTypes = new Set<NoteType>([
  "nudge",
  "nudge-failed",
  "handoff",
  "error",
  "expired",
]);

export async function addNote(
  conversation: Conversation,
  channel: Channel,
  note: Note,
) {
  insertEntry(conversation.entries, {
    kind: "note",
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...note,
  });
  await save(conversation);
  if (!channel.notes || !nativeTypes.has(note.type)) return;
  await channel.notes
    .add(conversation.chat, note.text)
    .catch((error: unknown) =>
      log("warn", "note.native_failed", {
        ...logFields(conversation),
        type: note.type,
        error: errorText(error),
      }),
    );
}
