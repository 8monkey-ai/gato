import type { Message, Update } from "grammy/types";

import type { InboundAttachment, InboundEvent } from "../channel.ts";

const unsupportedKinds = [
  "venue",
  "location",
  "contact",
  "poll",
  "dice",
  "game",
  "story",
  "invoice",
  "paid_media",
  "live_photo",
  "checklist",
  "giveaway",
  "giveaway_winners",
] as const;

type File = { file_id: string; file_size?: number };

function attachment(
  category: InboundAttachment["category"],
  file: File & { mime_type?: string; file_name?: string },
  mediaType = file.mime_type,
): InboundAttachment {
  return {
    category,
    source: file.file_id,
    ...(mediaType && { mediaType }),
    ...(file.file_name && { fileName: file.file_name }),
    ...(file.file_size !== undefined && { size: file.file_size }),
  };
}

function documentCategory(mediaType = ""): InboundAttachment["category"] {
  const top = mediaType.split("/")[0];
  return top === "image" || top === "audio" || top === "video"
    ? top
    : "document";
}

function stickerAttachment(sticker: NonNullable<Message["sticker"]>) {
  const animated = sticker.is_animated || sticker.is_video;
  return animated
    ? attachment("other", sticker)
    : attachment("image", sticker, "image/webp");
}

function attachments(message: Message): InboundAttachment[] {
  const { photo, sticker, voice, audio } = message;
  // Telegram also sets document on animation messages.
  const document = message.animation ? undefined : message.document;
  const largestPhoto = photo?.at(-1);
  const videos = [message.video, message.video_note, message.animation];
  return [
    largestPhoto && attachment("image", largestPhoto, "image/jpeg"),
    sticker && stickerAttachment(sticker),
    document && attachment(documentCategory(document.mime_type), document),
    voice && attachment("audio", voice, voice.mime_type ?? "audio/ogg"),
    audio && attachment("audio", audio),
    ...videos.map((video) => video && attachment("video", video)),
  ].filter((item) => item !== undefined);
}

function messageText(message: Message, hasAttachments: boolean) {
  const text = message.text ?? message.caption;
  if (text !== undefined || hasAttachments) return text;
  const kind = unsupportedKinds.find((name) => message[name] !== undefined);
  return kind && `[unsupported ${kind} message]`;
}

// Returns undefined for messages without customer content, such as service messages.
export function inboundEvent(
  update: Update,
  message: Message,
): InboundEvent | undefined {
  const files = attachments(message);
  const text = messageText(message, files.length > 0);
  if (text === undefined && files.length === 0) return undefined;
  return {
    kind: "message",
    chatId: String(message.chat.id),
    eventId: `update:${update.update_id}`,
    message: {
      platformId: String(message.message_id),
      author: { role: "customer" },
      sentAt: new Date(message.date * 1000),
      ...(text !== undefined && { text }),
      attachments: files,
    },
  };
}
