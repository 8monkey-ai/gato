import type { Message } from "grammy/types";

import type { ChatEvent, IncomingAttachment } from "../channel.ts";

function categoryOf(
  mediaType: string | undefined,
): IncomingAttachment["category"] {
  const top = mediaType?.split("/")[0];
  if (top === "image" || top === "audio" || top === "video") return top;
  return "document";
}

type Found = IncomingAttachment | undefined;

function photo(message: Message): Found {
  const largest = message.photo?.at(-1);
  if (!largest) return undefined;
  return {
    category: "image",
    source: largest.file_id,
    mediaType: "image/jpeg",
    size: largest.file_size,
  };
}

function file(message: Message): Found {
  const item = message.document ?? message.audio;
  if (!item) return undefined;
  return {
    category: categoryOf(item.mime_type),
    source: item.file_id,
    mediaType: item.mime_type,
    name: item.file_name,
    size: item.file_size,
  };
}

function voice(message: Message): Found {
  const item = message.voice;
  if (!item) return undefined;
  const mediaType = item.mime_type ?? "audio/ogg";
  return {
    category: "audio",
    source: item.file_id,
    mediaType,
    size: item.file_size,
  };
}

function video(message: Message): Found {
  const item = message.video ?? message.animation;
  const note = message.video_note;
  if (note)
    return { category: "video", source: note.file_id, mediaType: "video/mp4" };
  if (!item) return undefined;
  return {
    category: "video",
    source: item.file_id,
    mediaType: item.mime_type,
    size: item.file_size,
  };
}

function sticker(message: Message): Found {
  const item = message.sticker;
  if (!item) return undefined;
  const moving = item.is_animated || item.is_video;
  return {
    category: moving ? "other" : "image",
    source: item.file_id,
    mediaType: moving ? "application/x-tgsticker" : "image/webp",
    size: item.file_size,
  };
}

function attachmentsOf(message: Message) {
  return [photo, file, voice, video, sticker]
    .map((read) => read(message))
    .filter((item) => item !== undefined);
}

// Telegram dates have second precision; keep the receive time when it falls in the same second.
function sentAt(seconds: number, now = Date.now()) {
  const start = seconds * 1000;
  return new Date(now >= start && now < start + 1000 ? now : start);
}

export function customerEvent(message: Message): ChatEvent | undefined {
  const text = message.text ?? message.caption;
  const attachments = attachmentsOf(message);
  if (text === undefined && attachments.length === 0) return undefined;
  const name = [message.from?.first_name, message.from?.last_name]
    .filter(Boolean)
    .join(" ");
  return {
    chat: String(message.chat.id),
    profile: name ? { name } : undefined,
    message: {
      ref: String(message.message_id),
      at: sentAt(message.date),
      role: "customer",
      text,
      attachments: attachments.length > 0 ? attachments : undefined,
      sender: {
        id: message.from ? String(message.from.id) : undefined,
        name: name || undefined,
      },
    },
  };
}

const commands: Record<
  string,
  (argument?: string) => Omit<ChatEvent, "chat"> | undefined
> = {
  pause: () => ({ ownership: { assignee: "human" } }),
  resume: () => ({ ownership: { assignee: "agent" } }),
  close: () => ({ ownership: { open: false } }),
  open: () => ({ ownership: { open: true } }),
  label: (label) => (label ? { labels: { add: [label] } } : undefined),
  unlabel: (label) => (label ? { labels: { remove: [label] } } : undefined),
};

export function operatorCommand(text: string): ChatEvent | undefined {
  const [command, chat, argument] = text.trim().split(/\s+/);
  const build = commands[command?.replace(/^\//, "").replace(/@.*$/, "") ?? ""];
  const change = chat ? build?.(argument) : undefined;
  return change && chat ? { chat, ...change } : undefined;
}
