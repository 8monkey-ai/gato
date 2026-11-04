import path from "node:path";

import type { ChannelConnection } from "../channels/channel.ts";
import type { Logger } from "../log.ts";
import type { RecordedMessage } from "../record/projection.ts";
import type { Attachment, ChatRef } from "../record/types.ts";
import type { ChatStore } from "../storage/chat-store.ts";

type Store = Pick<ChatStore, "load" | "append" | "saveAttachment">;

const plainExtension = /^[A-Za-z0-9]{1,10}$/;

function extensionOf(attachment: Attachment, mediaType?: string): string {
  const fromName = path.extname(attachment.fileName ?? "").slice(1);
  if (plainExtension.test(fromName)) return fromName.toLowerCase();
  const subtype = /^[^/]+\/([^;+]+)/.exec(mediaType ?? "")?.[1]?.trim() ?? "";
  return plainExtension.test(subtype) ? subtype.toLowerCase() : "bin";
}

type Input = {
  store: Store;
  ref: ChatRef;
  connection: Pick<ChannelConnection, "fetchAttachment">;
  log: Logger;
};

async function download(
  { store, ref, connection }: Input,
  message: RecordedMessage,
  attachment: Attachment,
) {
  const fetched = await connection.fetchAttachment(attachment.source);
  const mediaType = attachment.mediaType ?? fetched.mediaType;
  const name = `${message.id}-${attachment.id}.${extensionOf(attachment, mediaType)}`;
  const file = await store.saveAttachment(ref, name, fetched.bytes);
  return { file, mediaType: attachment.mediaType ? undefined : mediaType };
}

async function retrieveOne(
  input: Input,
  message: RecordedMessage,
  attachment: Attachment,
) {
  const target = { messageId: message.id, attachmentId: attachment.id };
  const result = await download(input, message, attachment).catch(
    (error: unknown) => {
      const retrievalError =
        error instanceof Error ? error.message : String(error);
      input.log.warn("attachment.retrieval_failed", {
        ...target,
        error: retrievalError,
      });
      return { retrievalError };
    },
  );
  await input.store.append(input.ref, [
    { type: "attachment-update", ...target, ...result },
  ]);
}

export async function retrieveMissing(input: Input) {
  const view = await input.store.load(input.ref);
  for (const message of view.messages)
    for (const attachment of message.attachments)
      if (!attachment.file) await retrieveOne(input, message, attachment);
}
