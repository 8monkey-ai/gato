import { afterEach, expect, mock, spyOn, test } from "bun:test";

import { Bot, HttpError } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";

import { createLogger } from "../../log.ts";
import type { InboundEvent, InboundMessage, OutboundPart } from "../channel.ts";
import { createTelegramConnection } from "./index.ts";

type Answer = (method: string) => unknown;

const botInfo = {
  id: 1,
  is_bot: true,
  first_name: "Gato",
  username: "gato_bot",
} as UserFromGetMe;

type AbortSignalLike = {
  addEventListener(type: "abort", listener: () => void): void;
};

function waitForAbort(signal: AbortSignalLike) {
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve({ ok: true, result: [] })),
  );
}

function telegramFake(options: { operatorChatId?: string; answer?: Answer }) {
  const calls: { method: string; payload: unknown }[] = [];
  const bot = new Bot("123:SECRET", { botInfo });
  bot.api.config.use((_prev, method, payload, signal) => {
    calls.push({ method, payload });
    if (method === "getUpdates" && signal) return waitForAbort(signal) as never;
    const fallback = { ok: true, result: method === "getUpdates" ? [] : true };
    return Promise.resolve((options.answer?.(method) ?? fallback) as never);
  });
  const connection = createTelegramConnection(
    "tg",
    { botToken: "123:SECRET", operatorChatId: options.operatorChatId },
    createLogger({}, () => {}),
    () => bot,
  );
  return { bot, calls, connection };
}

async function receive(message: Record<string, unknown>) {
  const fake = telegramFake({ operatorChatId: "-100" });
  const events: InboundEvent[] = [];
  await fake.connection.start((event) => {
    events.push(event);
    return Promise.resolve();
  });
  await fake.bot.handleUpdate({
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

const sentMessage = {
  ok: true,
  result: {
    message_id: 99,
    date: 1_700_000_100,
    chat: { id: 555, type: "private" },
  },
};

async function send(answer: Answer, part: OutboundPart) {
  const { connection, calls } = telegramFake({ answer });
  return { outcome: await connection.send("555", part), calls };
}

const hello = { kind: "text", text: "Hi" } as const;

test("sends plain text and reports the Telegram message id", async () => {
  expect(await send(() => sentMessage, hello)).toEqual({
    outcome: {
      status: "sent",
      platformId: "99",
      sentAt: new Date("2023-11-14T22:15:00.000Z"),
    },
    calls: [{ method: "sendMessage", payload: { chat_id: "555", text: "Hi" } }],
  });
});

test("reports rate limits as retryable and other API errors as permanent", async () => {
  const rateLimited = {
    ok: false,
    error_code: 429,
    description: "Too Many Requests",
    parameters: { retry_after: 7 },
  };
  expect((await send(() => rateLimited, hello)).outcome).toEqual({
    status: "failed",
    error: "Call to 'sendMessage' failed! (429: Too Many Requests)",
    retryAfterMs: 7000,
  });
  const badRequest = { ok: false, error_code: 400, description: "Bad Request" };
  expect((await send(() => badRequest, hello)).outcome).toEqual({
    status: "failed",
    error: "Call to 'sendMessage' failed! (400: Bad Request)",
  });
});

test("reports network errors as uncertain", async () => {
  const networkError = () => {
    throw new HttpError("Network request for 'sendVideo' failed!", "socket");
  };
  const video = { kind: "video", url: "https://v/x.mp4" } as const;
  expect(await send(networkError, video)).toEqual({
    outcome: {
      status: "uncertain",
      error: "HttpError: Network request for 'sendVideo' failed!",
    },
    calls: [
      {
        method: "sendVideo",
        payload: { chat_id: "555", video: "https://v/x.mp4" },
      },
    ],
  });
});

test("notifies operators only when an operator chat is configured", async () => {
  expect("notifyOperators" in telegramFake({}).connection).toBe(false);
  const { connection, calls } = telegramFake({ operatorChatId: "-100" });
  await connection.notifyOperators?.("555", "Customer asks for a human");
  expect(calls).toEqual([
    {
      method: "sendMessage",
      payload: { chat_id: "-100", text: "Chat 555: Customer asks for a human" },
    },
  ]);
});

test("gives the customer name as contact context", async () => {
  const chat = {
    id: 555,
    type: "private",
    first_name: "Ana",
    last_name: "Cruz",
  };
  const { connection } = telegramFake({
    answer: (method) =>
      method === "getChat" ? { ok: true, result: chat } : undefined,
  });
  expect(await connection.contactContext?.("555")).toEqual({
    name: "Ana Cruz",
  });
  const failing = telegramFake({
    answer: () => ({ ok: false, error_code: 400, description: "Bad Request" }),
  });
  expect(await failing.connection.contactContext?.("555")).toEqual({});
});

afterEach(() => {
  mock.restore();
});

test("downloads attachments with the token but keeps it out of errors", async () => {
  const urls: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation(((url: string) => {
    urls.push(url);
    return Promise.resolve(new Response("no", { status: 404 }));
  }) as typeof fetch);
  const { connection } = telegramFake({
    answer: () => ({
      ok: true,
      result: {
        file_id: "d1",
        file_unique_id: "d",
        file_path: "documents/file_1.pdf",
      },
    }),
  });
  const download = connection.fetchAttachment("d1");
  await expect(download).rejects.toThrow(
    /^Telegram file download failed: 404$/,
  );
  expect(urls).toEqual([
    "https://api.telegram.org/file/bot123:SECRET/documents/file_1.pdf",
  ]);
});
