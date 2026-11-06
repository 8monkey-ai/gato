import type { FilePart, ModelMessage, TextPart } from "ai";

import type { Connection } from "../channels/channel.ts";
import { ensureFiles } from "../conversation/files.ts";
import { isVisible } from "../conversation/history.ts";
import type { Attachment, MessageEntry } from "../record/chat-file.ts";
import type { Conversation } from "../record/store.ts";
import {
  defaultMediaTypes,
  isPreparedKind,
  type Preparer,
} from "./preparation.ts";

type Part = TextPart | FilePart;

const preparedAs = {
  image: "Description of the image by a model",
  document: "Content of the document as read by a model",
  audio: "Transcript of the audio by a model",
};

const attribution: Record<MessageEntry["role"], string> = {
  customer: "",
  agent: "",
  operator: "[Human colleague] ",
  workflow: "[Workflow] ",
};

export async function buildContext(
  conversation: Conversation,
  connection: Connection,
  prepare: Preparer,
  summary: string | undefined,
): Promise<ModelMessage[]> {
  const messages: ModelMessage[] = summary
    ? [
        {
          role: "assistant",
          content: `[Private notes about this contact]\n${summary}`,
        },
      ]
    : [];
  for (const entry of conversation.entries.filter(isVisible)) {
    if (entry.role !== "agent")
      await ensureFiles(conversation, connection, entry);
    const parts = await messageParts(conversation, entry, prepare);
    messages.push(...toMessages(entry, parts));
  }
  return messages;
}

async function messageParts(
  conversation: Conversation,
  entry: MessageEntry,
  prepare: Preparer,
) {
  const parts: Part[] = [];
  const text = attribution[entry.role] + (entry.text ?? "");
  if (text.trim()) parts.push({ type: "text", text });
  for (const attachment of entry.attachments ?? []) {
    parts.push(
      entry.role === "agent"
        ? {
            type: "text",
            text: `[${attachment.kind} sent: ${attachment.source}]`,
          }
        : await attachmentPart(conversation, attachment, prepare),
    );
  }
  return parts;
}

async function attachmentPart(
  conversation: Conversation,
  attachment: Attachment,
  prepare: Preparer,
): Promise<Part> {
  const label = `${attachment.kind}${attachment.name ? ` "${attachment.name}"` : ""}`;
  const kind = attachment.kind;
  if (!isPreparedKind(kind)) {
    return {
      type: "text",
      text: `[${label}: this attachment type is not supported and cannot be viewed]`,
    };
  }
  if (!attachment.file)
    return {
      type: "text",
      text: `[${label}: the file could not be retrieved]`,
    };
  const prepared = await prepare(attachment, attachment.file);
  if (prepared !== undefined) {
    return {
      type: "text",
      text: `[${label} attached. ${preparedAs[kind]}: ${prepared}]`,
    };
  }
  return {
    type: "file",
    data: await conversation.readAttachment(attachment.file),
    mediaType: attachment.mime ?? defaultMediaTypes[kind],
    filename: attachment.name,
  };
}

function toMessages(entry: MessageEntry, parts: Part[]): ModelMessage[] {
  if (!parts.length) return [];
  if (entry.role === "customer") return [{ role: "user", content: parts }];
  const texts = parts.filter((part) => part.type === "text");
  const files = parts.filter((part) => part.type === "file");
  if (files.length)
    texts.push({
      type: "text",
      text: `[${files.length} file(s), shown in the next message]`,
    });
  const text = texts.map((part) => part.text).join(" ");
  const messages: ModelMessage[] = [{ role: "assistant", content: text }];
  if (files.length) {
    const note = `[Files that the ${entry.role} in the message above sent to the customer. They are not from the customer.]`;
    messages.push({
      role: "user",
      content: [{ type: "text", text: note }, ...files],
    });
  }
  return messages;
}
