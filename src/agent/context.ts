import type { FilePart, ImagePart, ModelMessage, TextPart } from "ai";

import type { Attachment, Entry, MessageEntry } from "../record/entries.ts";

type UserPart = TextPart | ImagePart | FilePart;

interface ContextFile {
  read(file: string): Promise<Uint8Array>;
}

const directCategories = new Set(["image", "document", "audio"]);

function describe(attachment: Attachment): string {
  const name = attachment.name ? ` "${attachment.name}"` : "";
  return `${attachment.category} attachment${name}`;
}

function placeholder(attachment: Attachment, userSide: boolean): string {
  const what = describe(attachment);
  if (attachment.prepared)
    return `[${what}, interpreted by a model: ${attachment.prepared.text}]`;
  if (attachment.retrievalError)
    return `[${what}: the file could not be retrieved, its content is not available]`;
  if (!directCategories.has(attachment.category))
    return `[${what}: unsupported file type, its content is not available]`;
  if (!userSide)
    return `[${what}: files sent by colleagues cannot be given to the model, its content is not available]`;
  return `[${what}]`;
}

async function attachmentPart(
  attachment: Attachment,
  files: ContextFile,
): Promise<UserPart[]> {
  const direct =
    !attachment.prepared &&
    attachment.file &&
    directCategories.has(attachment.category);
  if (!direct || !attachment.file)
    return [{ type: "text", text: placeholder(attachment, true) }];
  const data = await files.read(attachment.file);
  const mediaType = attachment.mime ?? "application/octet-stream";
  const file: UserPart =
    attachment.category === "image"
      ? { type: "image", image: data, mediaType }
      : { type: "file", data, mediaType, filename: attachment.name };
  return [{ type: "text", text: placeholder(attachment, true) }, file];
}

function attribution(message: MessageEntry): string {
  if (message.role === "operator")
    return `[Human colleague ${message.sender ?? "(name unknown)"}] `;
  if (message.role === "workflow") return "[Workflow] ";
  return "";
}

async function toModelMessage(
  message: MessageEntry,
  files: ContextFile,
): Promise<ModelMessage> {
  const attachments = message.attachments ?? [];
  if (message.role !== "customer") {
    const text = [
      attribution(message) + message.text,
      ...attachments.map((a) => placeholder(a, false)),
    ];
    return { role: "assistant", content: text.filter(Boolean).join("\n") };
  }
  const parts: UserPart[] = message.text
    ? [{ type: "text", text: message.text }]
    : [];
  for (const attachment of attachments)
    parts.push(...(await attachmentPart(attachment, files)));
  return {
    role: "user",
    content: parts.length ? parts : [{ type: "text", text: "[empty message]" }],
  };
}

/** Messages that the customer saw or sent, in channel order. Drafts and internal records stay out. */
export function visibleMessages(entries: readonly Entry[]): MessageEntry[] {
  return entries.filter(
    (entry): entry is MessageEntry =>
      entry.type === "message" &&
      (entry.role !== "agent" || entry.delivery === "sent"),
  );
}

export async function buildContext(options: {
  entries: readonly Entry[];
  files: ContextFile;
  summary?: { date: string; text: string };
  nudgePrompt?: string;
}): Promise<ModelMessage[]> {
  const messages: ModelMessage[] = [];
  if (options.summary)
    messages.push({
      role: "assistant",
      content: `[Private notes about earlier conversation, written ${options.summary.date}. The customer did not see them.]\n${options.summary.text}`,
    });
  for (const message of visibleMessages(options.entries))
    messages.push(await toModelMessage(message, options.files));
  if (options.nudgePrompt)
    messages.push({ role: "user", content: options.nudgePrompt });
  return messages;
}
