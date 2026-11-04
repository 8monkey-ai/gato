import type { InboundAttachment, InboundMessage } from "../channel.ts";
import type { MessagePayload } from "./payloads.ts";

type Content = MessagePayload["message"]["message"];
type MappedContent = Pick<InboundMessage, "text" | "attachments">;
type FileContent = NonNullable<Content["attachment"]>;
type Category = InboundAttachment["category"];

const categories: Record<string, Category> = {
  image: "image",
  file: "document",
  audio: "audio",
  video: "video",
};

function mediaCategory(mediaType?: string): Category {
  if (!mediaType) return "other";
  const top = mediaType.split("/")[0] ?? "";
  return categories[top] ?? "document";
}

function toAttachment(
  attachment: FileContent,
  category?: Category,
): InboundAttachment {
  const size = Number(attachment.size);
  const mediaType = attachment.mime ?? attachment.mimeType ?? undefined;
  return {
    category:
      category ?? categories[attachment.type ?? ""] ?? mediaCategory(mediaType),
    source: attachment.url,
    mediaType,
    fileName: attachment.fileName ?? undefined,
    size: attachment.size != null && Number.isFinite(size) ? size : undefined,
  };
}

function joined(parts: (string | null | undefined)[], separator: string) {
  const text = parts.filter(Boolean).join(separator);
  return text === "" ? undefined : text;
}

const textOnly = (text?: string): MappedContent => ({ text, attachments: [] });

function location(content: Content) {
  const point =
    content.latitude != null && content.longitude != null
      ? `(${content.latitude}, ${content.longitude})`
      : undefined;
  return joined(["[location]", content.address, point], " ");
}

function template({ template }: Content) {
  const name = template?.name ? `[template ${template.name}]` : "[template]";
  const body = (template?.components ?? [])
    .filter((component) => component?.type?.toLowerCase() === "body")
    .map((component) => component?.text);
  return joined([name, ...body], "\n");
}

function storyReply({ story }: Content): MappedContent {
  const category = story?.type === "video" ? "video" : "image";
  return {
    text: "[story reply]",
    attachments: story ? [toAttachment(story, category)] : [],
  };
}

const mappers: Record<string, (content: Content) => MappedContent> = {
  text: (content) => textOnly(content.text ?? undefined),
  attachment: ({ attachment }) => ({
    text: attachment?.description || undefined,
    attachments: attachment ? [toAttachment(attachment)] : [],
  }),
  email: (content) => ({
    text: joined([content.subject, content.message], "\n\n"),
    attachments: (content.attachments ?? [])
      .filter((file) => file !== undefined)
      .map((file) => toAttachment(file)),
  }),
  location: (content) => textOnly(location(content)),
  quick_reply: (content) =>
    textOnly(joined([content.title, ...(content.replies ?? [])], "\n")),
  card: (content) =>
    textOnly(
      joined(
        [
          content.title,
          content.subtitle,
          ...(content.buttons ?? []).map((button) => button?.text),
        ],
        "\n",
      ),
    ),
  whatsapp_template: (content) => textOnly(template(content)),
  story_reply: storyReply,
};

export function mapContent(content: Content): MappedContent {
  const mapper = mappers[content.type];
  return mapper
    ? mapper(content)
    : textOnly(`[unsupported ${content.type} message]`);
}
