import { expect, test } from "bun:test";

import type { Update } from "grammy/types";

import type { InboundEvent, InboundMessage } from "../channel.ts";
import { telegramFake } from "./telegram-fixture.ts";

async function receive(message: Record<string, unknown>) {
  const fake = telegramFake({ operatorChatId: "-100" });
  const events: InboundEvent[] = [];
  await fake.connection.start((event) => {
    events.push(event);
    return Promise.resolve();
  });
  await fake.bots.at(-1)!.handleUpdate({
    update_id: 7,
    message: {
      message_id: 42,
      date: 1_700_000_000,
      chat: { id: 555, type: "private", first_name: "Ana" },
      from: { id: 555, is_bot: false, first_name: "Ana" },
      ...message,
    },
  } as unknown as Update);
  await fake.connection.stop();
  return events;
}

const customerMessage = (fields: Partial<InboundMessage>): InboundEvent[] => [
  {
    kind: "message",
    chatId: "555",
    eventId: "update:7",
    message: {
      platformId: "42",
      author: { role: "customer" },
      sentAt: new Date("2023-11-14T22:13:20.000Z"),
      attachments: [],
      ...fields,
    },
  },
];

test("maps a text message to a customer message event", async () => {
  expect(await receive({ text: "Hello" })).toEqual(
    customerMessage({ text: "Hello" }),
  );
});

test("maps the largest photo size and its caption", async () => {
  const photo = [
    { file_id: "small", file_unique_id: "s", width: 90, height: 90 },
    {
      file_id: "big",
      file_unique_id: "b",
      width: 800,
      height: 800,
      file_size: 9000,
    },
  ];
  expect(await receive({ photo, caption: "My receipt" })).toEqual(
    customerMessage({
      text: "My receipt",
      attachments: [
        {
          category: "image",
          source: "big",
          mediaType: "image/jpeg",
          size: 9000,
        },
      ],
    }),
  );
});

test("maps a voice note to ogg audio when Telegram gives no type", async () => {
  const voice = { file_id: "v1", file_unique_id: "v", duration: 3 };
  expect(await receive({ voice })).toEqual(
    customerMessage({
      attachments: [
        { category: "audio", source: "v1", mediaType: "audio/ogg" },
      ],
    }),
  );
});

test("maps a PDF document with its file name and size", async () => {
  const document = {
    file_id: "d1",
    file_unique_id: "d",
    file_name: "invoice.pdf",
    mime_type: "application/pdf",
    file_size: 1234,
  };
  expect(await receive({ document })).toEqual(
    customerMessage({
      attachments: [
        {
          category: "document",
          source: "d1",
          mediaType: "application/pdf",
          fileName: "invoice.pdf",
          size: 1234,
        },
      ],
    }),
  );
});

test("maps static stickers to webp images and animated stickers to other", async () => {
  const sticker = {
    file_id: "st1",
    file_unique_id: "st",
    type: "regular",
    width: 512,
    height: 512,
    is_animated: false,
    is_video: false,
  };
  expect(await receive({ sticker })).toEqual(
    customerMessage({
      attachments: [
        { category: "image", source: "st1", mediaType: "image/webp" },
      ],
    }),
  );
  expect(await receive({ sticker: { ...sticker, is_animated: true } })).toEqual(
    customerMessage({ attachments: [{ category: "other", source: "st1" }] }),
  );
});

test("marks content kinds without a mapping as unsupported", async () => {
  const location = { latitude: 1, longitude: 2 };
  expect(await receive({ location })).toEqual(
    customerMessage({ text: "[unsupported location message]" }),
  );
});

test("ignores the operator chat, bots, and service messages", async () => {
  const operatorChat = { id: -100, type: "group", title: "Ops" };
  expect(await receive({ chat: operatorChat, text: "hi" })).toEqual([]);
  const bot = { id: 9, is_bot: true, first_name: "Other" };
  expect(await receive({ from: bot, text: "hi" })).toEqual([]);
  expect(await receive({ new_chat_title: "New name" })).toEqual([]);
});
