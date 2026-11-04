import "../../src/channels/telegram/adapter.ts";

import { afterEach, expect, spyOn, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { createAdapters } from "../../src/app/channels.ts";
import { httpServer } from "../../src/app/http.ts";
import type { ChannelAdapter } from "../../src/channel/adapter.ts";
import type { InboundSink } from "../../src/channel/inbound.ts";
import { listChannels } from "../../src/channel/registry.ts";
import { inboundService } from "../../src/conversation/service.ts";
import { createLogger } from "../../src/log/logger.ts";
import { tmpDataDir } from "../support/data-dir.ts";
import { openTestStore } from "../support/store.ts";

const logger = createLogger({ GATO_LOG_LEVEL: "silent" });
const chat = { kind: "telegram", connection: "main", chatKey: "42" };
let server: ReturnType<typeof httpServer> | undefined;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;

afterEach(async () => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  await server?.stop();
  server = undefined;
});

function telegramAdapters(connections: Record<string, object>) {
  const telegram = listChannels().filter(({ kind }) => kind === "telegram");
  return createAdapters(
    telegram,
    { GATO_TELEGRAM_CONNECTIONS: JSON.stringify(connections) },
    logger,
  );
}

async function serve(
  adapters: ChannelAdapter[],
  sinkFor?: (adapter: ChannelAdapter) => InboundSink,
) {
  const dataDir = await tmpDataDir();
  const inbound = inboundService({
    store: await openTestStore(dataDir),
    logger,
  });
  for (const adapter of adapters) {
    await adapter.start(sinkFor?.(adapter) ?? inbound.sinkFor(adapter));
  }
  server = httpServer(adapters, 0, logger);
  server.start();
  return dataDir;
}

function post(connection: string, secret: string, update: object | string) {
  return fetch(new URL(`/telegram/${connection}`, server!.url), {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
    body: typeof update === "string" ? update : JSON.stringify(update),
  });
}

function textUpdate(updateId: number, chatType = "private") {
  return {
    update_id: updateId,
    message: {
      message_id: 5,
      date: 1711935000,
      chat: { id: 42, type: chatType },
      from: { id: 7, is_bot: false, first_name: "Ali", last_name: "Hassan" },
      text: "Hello",
    },
  };
}

async function eventsOf(dataDir: string, connection = "main") {
  const text = await readFile(
    join(dataDir, connection, "42", "events.jsonl"),
    "utf8",
  );
  return text
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line));
}

const main = { main: { botToken: "1:token", webhookSecret: "s3cret" } };

test("records a private text message under <connection>/<chat id>", async () => {
  const dataDir = await serve(telegramAdapters(main));

  const response = await post("main", "s3cret", textUpdate(1));

  expect(response.status).toBe(200);
  expect(await eventsOf(dataDir)).toEqual([
    {
      type: "message",
      seq: 1,
      at: 1711935000000,
      recordedAt: 1711938600000,
      dedupKey: "tg:1",
      messageId: "tg:1",
      role: "customer",
      sender: { id: "7", name: "Ali Hassan", known: true },
      parts: [{ kind: "text", text: "Hello" }],
      delivery: "received",
    },
  ]);
});

test("a repeated update is saved once", async () => {
  const dataDir = await serve(telegramAdapters(main));

  expect((await post("main", "s3cret", textUpdate(1))).status).toBe(200);
  expect((await post("main", "s3cret", textUpdate(1))).status).toBe(200);

  expect(await eventsOf(dataDir)).toHaveLength(1);
});

test("a wrong secret token gets 401 and saves nothing", async () => {
  const dataDir = await serve(telegramAdapters(main));

  expect((await post("main", "wrong", textUpdate(1))).status).toBe(401);
  expect((await post("main", "", textUpdate(2))).status).toBe(401);

  expect(await readdir(dataDir)).toEqual([]);
});

test("acknowledges and ignores group chats and updates without text", async () => {
  const dataDir = await serve(telegramAdapters(main));
  const sticker = {
    update_id: 3,
    message: { date: 1711935000, chat: { id: 42, type: "private" } },
  };

  expect((await post("main", "s3cret", textUpdate(1, "group"))).status).toBe(
    200,
  );
  expect((await post("main", "s3cret", sticker)).status).toBe(200);
  expect((await post("main", "s3cret", { update_id: 4 })).status).toBe(200);

  expect(await readdir(dataDir)).toEqual([]);
});

test("acknowledges and ignores a body that is not JSON", async () => {
  const dataDir = await serve(telegramAdapters(main));

  expect((await post("main", "s3cret", "not json")).status).toBe(200);

  expect(await readdir(dataDir)).toEqual([]);
});

test("a failed save gets 500, so Telegram sends the update again", async () => {
  await serve(telegramAdapters(main), () => ({
    accept: () => Promise.reject(new Error("disk full")),
  }));

  expect((await post("main", "s3cret", textUpdate(1))).status).toBe(500);
});

test("each connection has its own secret and chat folders", async () => {
  const dataDir = await serve(
    telegramAdapters({
      a: { botToken: "1:a", webhookSecret: "secret-a" },
      b: { botToken: "2:b", webhookSecret: "secret-b" },
    }),
  );

  expect((await post("a", "secret-b", textUpdate(1))).status).toBe(401);
  expect((await post("a", "secret-a", textUpdate(1))).status).toBe(200);
  expect((await post("b", "secret-b", textUpdate(1))).status).toBe(200);

  expect(await readdir(dataDir).then((names) => names.sort())).toEqual([
    "a",
    "b",
  ]);
  expect(await eventsOf(dataDir, "a")).toHaveLength(1);
  expect(await eventsOf(dataDir, "b")).toHaveLength(1);
});

/** Answers each Telegram API call and returns the calls made. */
function stubTelegram(answer: (url: string) => Response | Promise<Response>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const stub = async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return answer(url);
  };
  // grammy calls fetch with a URL string and a JSON body.
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    stub as unknown as typeof fetch,
  );
  return calls;
}

async function sendHello(settings: object = {}) {
  const [adapter] = telegramAdapters({ main: { ...main.main, ...settings } });
  return adapter!.send(chat, { kind: "text", text: "Hello" });
}

test("a sent message gives its Telegram message id", async () => {
  const calls = stubTelegram(() =>
    Response.json({ ok: true, result: { message_id: 99 } }),
  );

  expect(await sendHello()).toEqual({ status: "sent", externalId: "99" });
  expect(calls).toEqual([
    {
      url: "https://api.telegram.org/bot1:token/sendMessage",
      body: { chat_id: "42", text: "Hello" },
    },
  ]);
});

test("429 is a rejection to retry after the given time", async () => {
  stubTelegram(() =>
    Response.json({
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry after 3",
      parameters: { retry_after: 3 },
    }),
  );

  expect(await sendHello()).toEqual({
    status: "rejected",
    permanent: false,
    retryAfterMs: 3000,
  });
});

test("403 is a permanent rejection", async () => {
  stubTelegram(() =>
    Response.json({
      ok: false,
      error_code: 403,
      description: "Forbidden: bot was blocked by the user",
    }),
  );

  expect(await sendHello()).toEqual({ status: "rejected", permanent: true });
});

test("a network error is uncertain", async () => {
  stubTelegram(() => Promise.reject(new TypeError("connection reset")));

  expect(await sendHello()).toEqual({ status: "uncertain" });
});

test("a 5xx answer is uncertain", async () => {
  stubTelegram(() =>
    Response.json({
      ok: false,
      error_code: 502,
      description: "Bad Gateway",
    }),
  );

  expect(await sendHello()).toEqual({ status: "uncertain" });
});

test("a call without an answer within requestTimeout is uncertain", async () => {
  stubTelegram(() => new Promise<Response>(() => {}));

  expect(await sendHello({ requestTimeout: "10ms" })).toEqual({
    status: "uncertain",
  });
});

function startWithUrl() {
  const [adapter] = telegramAdapters({
    main: { ...main.main, publicUrl: "https://gato.example.com" },
  });
  return adapter!.start({ accept: () => Promise.resolve("saved") });
}

test("a failed start gives an error without the bot token", async () => {
  // Bun puts the request URL, with the token, on its fetch errors.
  stubTelegram((url) =>
    Promise.reject(
      Object.assign(new TypeError("Unable to connect"), { path: url }),
    ),
  );

  const error = await startWithUrl().catch((error: unknown) => error);

  expect(error).toEqual(new Error("Telegram setWebhook failed: network error"));
  expect(Bun.inspect(error)).not.toContain("1:token");
});

test("a start that Telegram refuses gives its description", async () => {
  stubTelegram(() =>
    Response.json({ ok: false, error_code: 401, description: "Unauthorized" }),
  );

  await expect(startWithUrl()).rejects.toThrow(
    new Error("Telegram setWebhook failed: Unauthorized"),
  );
});

test("start sets the webhook when publicUrl is set", async () => {
  const calls = stubTelegram(() => Response.json({ ok: true, result: true }));
  const [withUrl, withoutUrl] = telegramAdapters({
    main: { ...main.main, publicUrl: "https://gato.example.com/" },
    other: { botToken: "2:other", webhookSecret: "s" },
  });
  const sink: InboundSink = { accept: () => Promise.resolve("saved") };

  await withUrl!.start(sink);
  await withoutUrl!.start(sink);

  expect(calls).toEqual([
    {
      url: "https://api.telegram.org/bot1:token/setWebhook",
      body: {
        url: "https://gato.example.com/telegram/main",
        secret_token: "s3cret",
      },
    },
  ]);
});
