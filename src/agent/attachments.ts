import type { LanguageModel } from "ai";
import { generateText } from "ai";

import type { Attachment, Entry, MessageEntry } from "../conversation/entry.ts";
import { messages } from "../conversation/record.ts";
import type { Conversation } from "../conversation/store.ts";
import { readFile, save } from "../conversation/store.ts";
import type { ContentPart } from "./context.ts";
import type { Budget } from "./runner.ts";

export type PreparedCategory = "image" | "document" | "audio";

export type PreparationModels = Partial<
  Record<PreparedCategory, { id: string; model: LanguageModel }>
>;

const prompts: Record<PreparedCategory, string> = {
  image: "Describe this image as text. Include all visible text.",
  document:
    "Return the textual content of this document. If it has no text, describe what it shows.",
  audio: "Transcribe this audio. Return only the transcript.",
};

const labels: Record<PreparedCategory, string> = {
  image: "image description",
  document: "document content",
  audio: "audio transcript",
};

function isPrepared(
  category: Attachment["category"],
): category is PreparedCategory {
  return (
    category === "image" || category === "document" || category === "audio"
  );
}

function attachmentsOf(entries: Entry[]) {
  return messages(entries).flatMap((entry) => entry.attachments ?? []);
}

async function prepareOne(
  conversation: Conversation,
  attachment: Attachment,
  choice: { id: string; model: LanguageModel },
  budget: Budget,
) {
  if (budget.steps <= 0)
    throw new Error(
      "The work limit was reached during attachment preparation.",
    );
  budget.steps--;
  const data = await readFile(conversation, attachment.file!);
  const prompt = prompts[attachment.category as PreparedCategory];
  const file = {
    type: "file" as const,
    data,
    mediaType: attachment.mediaType ?? "application/octet-stream",
    filename: attachment.name,
  };
  const { text } = await generateText({
    model: choice.model,
    messages: [
      { role: "user", content: [{ type: "text", text: prompt }, file] },
    ],
    abortSignal: budget.signal,
    maxRetries: 0,
  });
  if (text.trim() === "")
    throw new Error(
      `The preparation model gave no usable text for attachment ${attachment.id}.`,
    );
  attachment.prepared = {
    model: choice.id,
    text: text.trim(),
    at: new Date().toISOString(),
  };
  await save(conversation);
}

export async function prepareAttachments(
  conversation: Conversation,
  entries: Entry[],
  models: PreparationModels,
  budget: Budget,
) {
  for (const attachment of attachmentsOf(entries)) {
    const choice = isPrepared(attachment.category)
      ? models[attachment.category]
      : undefined;
    if (choice && attachment.file && !attachment.prepared)
      await prepareOne(conversation, attachment, choice, budget);
  }
}

export async function loadDirectFiles(
  conversation: Conversation,
  entries: Entry[],
  models: PreparationModels,
) {
  const files = new Map<string, Uint8Array>();
  for (const attachment of attachmentsOf(entries)) {
    const direct =
      isPrepared(attachment.category) && !models[attachment.category];
    if (direct && attachment.file)
      files.set(attachment.id, await readFile(conversation, attachment.file));
  }
  return files;
}

function describe(attachment: Attachment) {
  const details = [
    attachment.mediaType,
    attachment.size ? `${attachment.size} bytes` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const name = attachment.name ? ` "${attachment.name}"` : "";
  return `${attachment.category}${name}${details ? ` (${details})` : ""}`;
}

function attachmentParts(
  attachment: Attachment,
  files: Map<string, Uint8Array>,
  models: PreparationModels,
): ContentPart[] {
  const caption = attachment.description
    ? [
        {
          type: "text" as const,
          text: `[Attachment description: ${attachment.description}]`,
        },
      ]
    : [];
  if (!isPrepared(attachment.category)) {
    return [
      {
        type: "text",
        text: `[Unsupported attachment: ${describe(attachment)}. Its content is not available.]`,
      },
      ...caption,
    ];
  }
  if (!attachment.file) {
    return [
      {
        type: "text",
        text: `[Attachment ${describe(attachment)} could not be retrieved.]`,
      },
      ...caption,
    ];
  }
  if (models[attachment.category]) {
    const label = labels[attachment.category];
    return [
      {
        type: "text",
        text: `[Attachment ${describe(attachment)}, ${label} by a model: ${attachment.prepared?.text}]`,
      },
      ...caption,
    ];
  }
  const data = files.get(attachment.id)!;
  const mediaType = attachment.mediaType ?? "application/octet-stream";
  return [
    { type: "file", data, mediaType, filename: attachment.name },
    ...caption,
  ];
}

export function createRenderer(
  files: Map<string, Uint8Array>,
  models: PreparationModels,
) {
  return (entry: MessageEntry): ContentPart[] => {
    const text: ContentPart[] = entry.text
      ? [{ type: "text", text: entry.text }]
      : [];
    const attached = (entry.attachments ?? []).flatMap((attachment) =>
      attachmentParts(attachment, files, models),
    );
    const parts = [...text, ...attached];
    return parts.length > 0
      ? parts
      : [{ type: "text", text: "[Empty message]" }];
  };
}
