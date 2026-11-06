import { generateText, type LanguageModel } from "ai";

import type { Channel } from "../channels/channel.ts";
import { errorText, log } from "../log.ts";
import type { Attachment, MessageEntry } from "../record/entries.ts";
import type { Chat } from "../record/store.ts";

export type PreparedCategory = "image" | "document" | "audio";

export interface Preparation {
  models: Partial<Record<PreparedCategory, string>>;
  prompts: Record<PreparedCategory, string>;
  model: (id: string) => LanguageModel;
}

async function retrieve(
  chat: Chat,
  channel: Channel,
  message: MessageEntry,
  index: number,
  attachment: Attachment,
): Promise<Attachment> {
  if (attachment.file || attachment.retrievalError || !attachment.source)
    return attachment;
  try {
    const { data, mime } = await channel.download(attachment.source);
    const name = `${message.id}-${index}-${attachment.name ?? attachment.category}`;
    const file = await chat.saveAttachment(name, data);
    return { ...attachment, file, mime: attachment.mime ?? mime };
  } catch (error) {
    log.warn("attachment.retrieval_failed", {
      conversation: chat.id,
      message: message.id,
      error: errorText(error),
    });
    return { ...attachment, retrievalError: errorText(error) };
  }
}

async function prepare(
  chat: Chat,
  attachment: Attachment,
  preparation: Preparation,
  signal: AbortSignal,
): Promise<Attachment> {
  const category = attachment.category as PreparedCategory;
  const modelId = preparation.models[category];
  if (!modelId || !attachment.file || attachment.prepared) return attachment;
  const data = await chat.readAttachment(attachment.file);
  const mediaType = attachment.mime ?? "application/octet-stream";
  const { text } = await generateText({
    model: preparation.model(modelId),
    instructions: preparation.prompts[category],
    messages: [
      {
        role: "user",
        content: [{ type: "file", data, mediaType, filename: attachment.name }],
      },
    ],
    abortSignal: signal,
  });
  if (!text.trim())
    throw new Error(`the ${category} model gave an empty response`);
  return { ...attachment, prepared: { text: text.trim(), model: modelId } };
}

async function replace(
  chat: Chat,
  entry: MessageEntry,
  index: number,
  before: Attachment,
  after: Attachment,
) {
  if (before === after) return;
  const attachments = [...(entry.attachments ?? [])];
  attachments[index] = after;
  await chat.update(entry, { attachments });
}

/** Stores originals and saves preparation results for reuse. Throws instead of inventing content. */
export async function prepareAttachments(options: {
  chat: Chat;
  channel: Channel;
  preparation: Preparation;
  signal: AbortSignal;
}) {
  const { chat, channel, preparation, signal } = options;
  for (const entry of chat.entries) {
    if (entry.type !== "message" || !entry.attachments?.length) continue;
    for (const [index, attachment] of [...entry.attachments].entries()) {
      const stored = await retrieve(chat, channel, entry, index, attachment);
      await replace(chat, entry, index, attachment, stored);
      const prepared = await prepare(chat, stored, preparation, signal);
      await replace(chat, entry, index, stored, prepared);
    }
  }
}
