import { afterEach, expect, mock, spyOn, test } from "bun:test";

import { HttpError } from "grammy";

import type { OutboundPart } from "../channel.ts";
import { type Answer, telegramFake } from "./telegram-fixture.ts";

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

test("downloads attachments with the caller's signal and keeps the token out of errors", async () => {
  const urls: string[] = [];
  const fetchSignals: (AbortSignal | null | undefined)[] = [];
  spyOn(globalThis, "fetch").mockImplementation(((
    url: string,
    init?: RequestInit,
  ) => {
    urls.push(url);
    fetchSignals.push(init?.signal);
    return Promise.resolve(new Response("no", { status: 404 }));
  }) as typeof fetch);
  const { connection, signals } = telegramFake({
    answer: () => ({
      ok: true,
      result: {
        file_id: "d1",
        file_unique_id: "d",
        file_path: "documents/file_1.pdf",
      },
    }),
  });
  const caller = new AbortController();
  const download = connection.fetchAttachment("d1", caller.signal);
  await expect(download).rejects.toThrow(
    /^Telegram file download failed: 404$/,
  );
  expect(urls).toEqual([
    "https://api.telegram.org/file/bot123:SECRET/documents/file_1.pdf",
  ]);
  caller.abort();
  expect([signals.get("getFile")?.aborted, fetchSignals[0]?.aborted]).toEqual([
    true,
    true,
  ]);
});

test("sends simple Markdown as readable plain text", async () => {
  const markdown = {
    kind: "text",
    text: "## Hi\n**Ana**, see [help](https://h.test)",
  } as const;
  const { calls } = await send(() => sentMessage, markdown);
  expect(calls).toEqual([
    {
      method: "sendMessage",
      payload: { chat_id: "555", text: "Hi\nAna, see help (https://h.test)" },
    },
  ]);
});
