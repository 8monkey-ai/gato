import type { Message, Update } from "grammy/types";

import { fromSeconds, type IncomingMessage } from "../channel.ts";

type Attachment = IncomingMessage["attachments"][number];

export function toIncoming(update: Update): IncomingMessage | undefined {
  const message = update.message;
  if (!message) return undefined;
  const attachments = attachmentsOf(message);
  const text = message.text ?? message.caption;
  return {
    contact: String(message.chat.id),
    ref: String(message.message_id),
    role: "customer",
    at: fromSeconds(message.date),
    ...(text ? { text } : {}),
    attachments:
      attachments.length || text
        ? attachments
        : [{ kind: "other", source: "", name: contentType(message) }],
  };
}

function attachmentsOf(message: Message): Attachment[] {
  const photo = message.photo?.at(-1);
  if (photo)
    return [
      {
        kind: "image",
        source: photo.file_id,
        mime: "image/jpeg",
        name: "photo.jpg",
      },
    ];
  if (message.sticker) return [stickerOf(message.sticker)];
  const file = fileOf(message);
  return file ? [file] : [];
}

function stickerOf(sticker: NonNullable<Message["sticker"]>): Attachment {
  if (sticker.is_video)
    return {
      kind: "video",
      source: sticker.file_id,
      name: "sticker",
      mime: "video/webm",
    };
  return {
    kind: sticker.is_animated ? "other" : "image",
    source: sticker.file_id,
    name: "sticker",
    mime: "image/webp",
  };
}

function fileOf(message: Message): Attachment | undefined {
  const files = [
    ["audio", message.voice],
    ["audio", message.audio],
    ["video", message.video],
    ["video", message.video_note],
    ["video", message.animation],
    [undefined, message.document],
  ] as const;
  const [kind, file] = files.find(([, candidate]) => candidate) ?? [];
  if (!file) return undefined;
  const mime = "mime_type" in file ? file.mime_type : undefined;
  const name = "file_name" in file ? file.file_name : undefined;
  return {
    kind: kind ?? kindOfMime(mime),
    source: file.file_id,
    ...(mime ? { mime } : {}),
    ...(name ? { name } : {}),
  };
}

function kindOfMime(mime = ""): Attachment["kind"] {
  const top = mime.split("/")[0];
  return top === "image" || top === "audio" || top === "video"
    ? top
    : "document";
}

function contentType(message: Message): string {
  const known = [
    "location",
    "contact",
    "poll",
    "venue",
    "dice",
    "game",
    "story",
  ] as const;
  return known.find((key) => key in message) ?? "message";
}
