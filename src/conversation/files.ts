import type { Connection } from "../channels/channel.ts";
import { log, redact } from "../log.ts";
import type { Attachment, MessageEntry } from "../record/chat-file.ts";
import type { Conversation } from "../record/store.ts";

const downloads = new WeakMap<Attachment, Promise<void>>();

export async function ensureFiles(
  conversation: Conversation,
  connection: Connection,
  entry: MessageEntry,
): Promise<void> {
  await Promise.all(
    (entry.attachments ?? [])
      .filter((a) => a.source && !a.file && !a.retrievalError)
      .map((attachment) => {
        let download = downloads.get(attachment);
        if (!download) {
          download = retrieve(conversation, connection, attachment);
          downloads.set(attachment, download);
        }
        return download;
      }),
  );
}

async function retrieve(
  conversation: Conversation,
  connection: Connection,
  attachment: Attachment,
) {
  try {
    const { bytes, mime } = await connection.download(attachment.source);
    const file = await conversation.writeAttachment(
      bytes,
      attachment.name ?? attachment.kind,
    );
    await conversation.lock(async (edit) => {
      attachment.file = file;
      attachment.mime ??= mime;
      await edit.save();
    });
  } catch (error) {
    const reason = redact((error as Error).message);
    log.warn("attachment.retrieval_failed", {
      connection: connection.id,
      contact: conversation.contact,
      reason,
    });
    await conversation.lock(async (edit) => {
      attachment.retrievalError = `The file could not be retrieved: ${reason}`;
      await edit.save();
    });
  }
}
