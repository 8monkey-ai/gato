import type { InboundAttachment, InboundMessage } from "../channel.ts";
import type { MessagePayload } from "./payloads.ts";

type Content = MessagePayload["message"]["message"];
type MappedContent = Pick<InboundMessage, "text" | "attachments">;

const categories: Record<string, InboundAttachment["category"]> = {
  image: "image",
  file: "document",
  audio: "audio",
  video: "video",
};

function toAttachment(
  attachment: NonNullable<Content["attachment"]>,
): InboundAttachment {
  const size = Number(attachment.size);
  return {
    category: categories[attachment.type] ?? "other",
    source: attachment.url,
    mediaType: attachment.mime ?? attachment.mimeType ?? undefined,
    fileName: attachment.fileName ?? undefined,
    size: attachment.size != null && Number.isFinite(size) ? size : undefined,
  };
}

function joined(parts: (string | null | undefined)[], separator: string) {
  const text = parts.filter(Boolean).join(separator);
  return text === "" ? undefined : text;
}

function location(content: Content) {
  const point =
    content.latitude != null && content.longitude != null
      ? `(${content.latitude}, ${content.longitude})`
      : undefined;
  return joined(["[location]", content.address, point], " ");
}

export function mapContent(content: Content): MappedContent {
  switch (content.type) {
    case "text":
      return { text: content.text ?? undefined, attachments: [] };
    case "attachment":
      return {
        text: content.attachment?.description || undefined,
        attachments: content.attachment
          ? [toAttachment(content.attachment)]
          : [],
      };
    case "email":
      return {
        text: joined([content.subject, content.message], "\n\n"),
        attachments: [],
      };
    case "location":
      return { text: location(content), attachments: [] };
    default:
      return { text: `[unsupported ${content.type} message]`, attachments: [] };
  }
}
