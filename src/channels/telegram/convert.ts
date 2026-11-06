import type { Message } from "grammy/types";

import { categoryOf } from "../category.ts";
import type { IncomingAttachment, IncomingMessage } from "../channel.ts";

const unsupportedKinds = [
  "location",
  "contact",
  "poll",
  "venue",
  "dice",
  "game",
] as const;

type Extract = (message: Message) => IncomingAttachment | undefined;

const photo: Extract = (message) => {
  const size = message.photo?.at(-1);
  return (
    size && {
      category: "image",
      mime: "image/jpeg",
      name: "photo.jpg",
      source: size.file_id,
    }
  );
};

const sticker: Extract = ({ sticker }) => {
  if (!sticker) return undefined;
  if (sticker.is_animated || sticker.is_video)
    return {
      category: "other",
      name: "animated sticker",
      source: sticker.file_id,
    };
  return {
    category: "image",
    mime: "image/webp",
    name: "sticker.webp",
    source: sticker.file_id,
  };
};

const voice: Extract = ({ voice }) =>
  voice && {
    category: "audio",
    mime: voice.mime_type ?? "audio/ogg",
    name: "voice.ogg",
    source: voice.file_id,
  };

const video: Extract = (message) => {
  const file = message.video ?? message.animation ?? message.video_note;
  return (
    file && {
      category: "video",
      mime: "video/mp4",
      name: "video",
      source: file.file_id,
    }
  );
};

const file: Extract = (message) => {
  const file = message.document ?? message.audio;
  return (
    file && {
      category: categoryOf(file.mime_type),
      mime: file.mime_type,
      name: file.file_name,
      source: file.file_id,
    }
  );
};

function media(message: Message): IncomingAttachment[] {
  for (const extract of [photo, sticker, voice, video, file]) {
    const attachment = extract(message);
    if (attachment) return [attachment];
  }
  return [];
}

function senderName(message: Message): string | undefined {
  const from = message.from;
  if (!from) return undefined;
  return (
    [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username
  );
}

/** Telegram gives whole seconds. The receipt time keeps the order inside that second. */
function sentTime(seconds: number): Date {
  const start = seconds * 1000;
  return new Date(Math.max(start, Math.min(Date.now(), start + 999)));
}

/** A standard bot sees only customer messages. The bot's own sends are recorded when they are sent. */
export function toIncoming(message: Message): IncomingMessage {
  const unsupported = unsupportedKinds.filter(
    (kind) => message[kind] !== undefined,
  );
  const text = [
    message.text ?? message.caption ?? "",
    ...unsupported.map((kind) => `[unsupported Telegram content: ${kind}]`),
  ]
    .filter(Boolean)
    .join("\n");
  return {
    ref: String(message.message_id),
    at: sentTime(message.date),
    role: "customer",
    sender: senderName(message),
    text,
    attachments: media(message),
    answerable: true,
  };
}
