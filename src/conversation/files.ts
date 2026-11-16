import type { Connection } from "../channels/channel.ts";
import { log, redact } from "../log.ts";
import type { Attachment, MessageEntry } from "../record/chat-file.ts";
import type { Conversation } from "../record/store.ts";

const downloads = new Map<string, Promise<Partial<Attachment>>>();

export async function ensureFiles(
  conversation: Conversation,
  connection: Connection,
  entry: MessageEntry,
): Promise<void> {
  await Promise.all(
    (entry.attachments ?? []).map(async (attachment, index) => {
      if (!attachment.source || attachment.file || attachment.retrievalError)
        return;
      const key = `${conversation.id} ${entry.at} ${entry.ref} ${index}`;
      let download = downloads.get(key);
      if (!download) {
        download = retrieve(
          conversation,
          connection,
          entry,
          attachment,
        ).finally(() => downloads.delete(key));
        downloads.set(key, download);
      }
      Object.assign(attachment, await download);
    }),
  );
}

async function retrieve(
  conversation: Conversation,
  connection: Connection,
  entry: MessageEntry,
  attachment: Attachment,
) {
  let fields: Partial<Attachment>;
  try {
    const { bytes, mime } = await connection.download(attachment.source);
    const file = await conversation.writeAttachment(
      bytes,
      attachment.name ?? attachment.kind,
    );
    fields = { file, mime: attachment.mime ?? mime };
  } catch (error) {
    const reason = redact((error as Error).message);
    log.warn("attachment.retrieval_failed", {
      connection: connection.id,
      contact: conversation.contact,
      reason,
    });
    fields = { retrievalError: `The file could not be retrieved: ${reason}` };
  }
  await conversation.updateAttachment(entry, attachment, fields);
  return fields;
}
