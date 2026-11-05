import type { Channel } from "../channels/channel.ts";
import { errorText, log } from "../log.ts";
import type { Attachment } from "./entry.ts";
import { messages } from "./record.ts";
import type { Conversation } from "./store.ts";
import { logFields, save, saveFile } from "./store.ts";

function fileName(attachment: Attachment) {
  const extension = attachment.name?.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? "";
  return `${attachment.id}${extension}`;
}

async function retrieveOne(
  conversation: Conversation,
  channel: Channel,
  attachment: Attachment,
) {
  try {
    const { data, mediaType } = await channel.retrieve(attachment.source);
    attachment.file = await saveFile(conversation, fileName(attachment), data);
    attachment.mediaType ??= mediaType;
  } catch (error) {
    attachment.retrievalError = errorText(error);
    log("warn", "attachment.retrieval_failed", {
      ...logFields(conversation),
      attachment: attachment.id,
      error: attachment.retrievalError,
    });
  }
  await save(conversation);
}

async function retrievePending(conversation: Conversation, channel: Channel) {
  const pending = messages(conversation.entries)
    .flatMap((entry) => entry.attachments ?? [])
    .filter((a) => a.source !== "" && !a.file && !a.retrievalError);
  for (const attachment of pending)
    await retrieveOne(conversation, channel, attachment);
}

export function createRetriever(
  channelOf: (conversation: Conversation) => Channel,
) {
  const inflight = new Map<Conversation, Promise<void>>();
  return function retrieve(conversation: Conversation): Promise<void> {
    const current = inflight.get(conversation);
    const next = (current ?? Promise.resolve()).then(() =>
      retrievePending(conversation, channelOf(conversation)),
    );
    inflight.set(conversation, next);
    void next.finally(
      () =>
        inflight.get(conversation) === next && inflight.delete(conversation),
    );
    return next;
  };
}
