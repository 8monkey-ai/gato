import { expect, test } from "bun:test";

import type { Message } from "grammy/types";

import { toIncoming } from "./convert.ts";

const base: Partial<Message> = {
  message_id: 3,
  date: 1_700_000_000,
  chat: { id: 1, type: "private" as const, first_name: "A" },
  from: { id: 1, is_bot: false, first_name: "Ali", last_name: "Bin" },
};

test("text, caption, and sender become a customer message", () => {
  const incoming = toIncoming({ ...base, text: "hello" } as Message);
  expect(incoming).toMatchObject({
    ref: "3",
    role: "customer",
    sender: "Ali Bin",
    text: "hello",
    attachments: [],
    answerable: true,
  });
  expect(incoming.at.getTime()).toBeGreaterThanOrEqual(1_700_000_000_000);
  expect(incoming.at.getTime()).toBeLessThan(1_700_000_001_000);
});

test("media maps to attachment categories, and other content is marked unsupported", () => {
  const photo = toIncoming({
    ...base,
    photo: [{ file_id: "small" }, { file_id: "large" }],
  } as Message);
  expect(photo.attachments).toEqual([
    {
      category: "image",
      mime: "image/jpeg",
      name: "photo.jpg",
      source: "large",
    },
  ]);
  const pdf = toIncoming({
    ...base,
    document: {
      file_id: "d",
      mime_type: "application/pdf",
      file_name: "a.pdf",
    },
  } as Message);
  expect(pdf.attachments[0]?.category).toBe("document");
  const animated = toIncoming({
    ...base,
    sticker: { file_id: "s", is_animated: true },
  } as Message);
  expect(animated.attachments[0]?.category).toBe("other");
  const location = toIncoming({
    ...base,
    location: { latitude: 1, longitude: 2 },
  } as Message);
  expect(location.text).toBe("[unsupported Telegram content: location]");
});
