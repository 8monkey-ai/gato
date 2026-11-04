import type { FilePart, JSONValue, ModelMessage, TextPart } from "ai";

import { PreparationError } from "../attachments/prepare.ts";
import {
  attachmentName,
  mediaTypeOf,
  preparedText,
} from "../attachments/representation.ts";
import type { RecordedMessage } from "../record/projection.ts";
import type {
  Attachment,
  AttachmentCategory,
  Author,
} from "../record/types.ts";
import type { HistoryItem } from "./history.ts";

export type ModelMessageOptions = {
  loadFile(relative: string): Promise<Uint8Array>;
  preparedCategories: Set<AttachmentCategory>;
};

type Part = TextPart | FilePart;

const directCategories: readonly AttachmentCategory[] = [
  "image",
  "document",
  "audio",
];

const text = (value: string): TextPart => ({ type: "text", text: value });

// The OpenRouter provider drops file parts in assistant messages, so a colleague's file needs a preparation model.
function assertModelTakesFile(attachment: Attachment, author: Author) {
  if (author.role === "customer") return;
  const { category } = attachment;
  throw new PreparationError(
    attachment,
    `main model cannot take ${category} files from colleagues; configure GATO_${category.toUpperCase()}_MODEL`,
  );
}

async function attachmentPart(
  attachment: Attachment,
  author: Author,
  options: ModelMessageOptions,
): Promise<Part> {
  if (!directCategories.includes(attachment.category))
    return text(
      `[${attachmentName(attachment)}: not supported, content unknown]`,
    );
  if (!attachment.file)
    return text(`[${attachmentName(attachment)}: could not be retrieved]`);
  if (!options.preparedCategories.has(attachment.category)) {
    assertModelTakesFile(attachment, author);
    return {
      type: "file",
      data: await options.loadFile(attachment.file),
      mediaType: mediaTypeOf(attachment),
      filename: attachment.fileName,
    };
  }
  const prepared = preparedText(attachment);
  if (prepared === undefined)
    throw new Error(`The ${attachmentName(attachment)} has no preparation`);
  return text(prepared);
}

function attribution(author: Author): string {
  if (author.role === "operator") {
    if (author.name === undefined && author.id === undefined)
      return "[Human colleague (unidentified)] ";
    return `[Human colleague${author.name ? ` ${author.name}` : ""}] `;
  }
  return author.role === "workflow" ? "[Workflow] " : "";
}

async function messageParts(
  message: RecordedMessage,
  options: ModelMessageOptions,
): Promise<Part[]> {
  const prefix = attribution(message.author);
  const body = `${prefix}${message.text ?? ""}`.trim();
  const attachments = await Promise.all(
    message.attachments.map((a) => attachmentPart(a, message.author, options)),
  );
  return body === "" ? attachments : [text(body), ...attachments];
}

async function fromMessage(
  message: RecordedMessage,
  options: ModelMessageOptions,
): Promise<ModelMessage[]> {
  const content = await messageParts(message, options);
  if (content.length === 0) return [];
  return message.author.role === "customer"
    ? [{ role: "user", content }]
    : [{ role: "assistant", content }];
}

function fromTool(
  item: Extract<HistoryItem, { kind: "tool" }>,
): ModelMessage[] {
  const { call, result } = item;
  const ids = { toolCallId: call.callId, toolName: call.name };
  const output = result.isError
    ? {
        type: "error-text" as const,
        value:
          typeof result.output === "string"
            ? result.output
            : JSON.stringify(result.output),
      }
    : { type: "json" as const, value: (result.output ?? null) as JSONValue };
  return [
    {
      role: "assistant",
      content: [{ type: "tool-call", ...ids, input: call.input }],
    },
    { role: "tool", content: [{ type: "tool-result", ...ids, output }] },
  ];
}

export async function toModelMessages(
  items: HistoryItem[],
  options: ModelMessageOptions,
): Promise<ModelMessage[]> {
  const groups = await Promise.all(
    items.map(async (item): Promise<ModelMessage[]> => {
      if (item.kind === "message") return fromMessage(item.message, options);
      if (item.kind === "tool") return fromTool(item);
      return [
        {
          role: "user",
          content: `[Internal trigger, not from the customer] ${item.trigger.text}`,
        },
      ];
    }),
  );
  return groups.flat();
}
