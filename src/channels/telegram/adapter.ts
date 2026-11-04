import { timingSafeEqual } from "node:crypto";

import { Api, GrammyError } from "grammy";
import { z } from "zod";

import {
  type ChannelAdapter,
  connectionPath,
  type OutboundPart,
  type SendResult,
} from "../../channel/adapter.ts";
import type { InboundSink } from "../../channel/inbound.ts";
import { registerChannel } from "../../channel/registry.ts";
import { duration } from "../../config/env.ts";
import type { ChatRef } from "../../conversation/state.ts";
import type { Logger } from "../../log/logger.ts";
import { inboundOf } from "./inbound.ts";

const telegramSettings = z.object({
  botToken: z.string().min(1),
  webhookSecret: z
    .string()
    .regex(
      /^[\w-]{1,256}$/,
      "expected 1 to 256 characters from A-Z, a-z, 0-9, _ and -",
    ),
  publicUrl: z.url({ protocol: /^https$/ }).optional(),
  requestTimeout: duration.default(30_000),
});
type Settings = z.infer<typeof telegramSettings>;

class TelegramAdapter implements ChannelAdapter {
  readonly kind = "telegram";
  readonly capabilities = {
    maxTextLength: 4096,
    formatting: "plain" as const,
    videoByUrl: true,
    operatorMessageEvents: false,
  };
  readonly #api: Api;
  #sink: InboundSink | undefined;

  constructor(
    readonly connection: string,
    private readonly settings: Settings,
    private readonly logger: Logger,
  ) {
    this.#api = new Api(settings.botToken, {
      fetch,
      timeoutSeconds: settings.requestTimeout / 1000,
    });
  }

  routes() {
    return [
      {
        method: "POST" as const,
        path: "",
        handle: (request: Request) => this.#receive(request),
      },
    ];
  }

  async start(sink: InboundSink) {
    this.#sink = sink;
    const { publicUrl, webhookSecret } = this.settings;
    if (publicUrl) {
      const url = `${publicUrl.replace(/\/+$/, "")}${connectionPath(this)}`;
      await this.#api
        .setWebhook(url, { secret_token: webhookSecret })
        .catch((error: unknown) => {
          throw safeError("setWebhook", error);
        });
    }
  }

  stop() {
    this.#sink = undefined;
    return Promise.resolve();
  }

  async send(chat: ChatRef, part: OutboundPart): Promise<SendResult> {
    try {
      const sent = await this.#api.sendMessage(chat.chatKey, part.text);
      return { status: "sent", externalId: String(sent.message_id) };
    } catch (error) {
      return failedSend(error);
    }
  }

  /** Answers 200 only after the event is saved; a failed save answers 500, so Telegram sends the update again. */
  async #receive(request: Request): Promise<Response> {
    const secret = request.headers.get("x-telegram-bot-api-secret-token");
    if (!sameSecret(secret, this.settings.webhookSecret)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const sink = this.#sink;
    if (!sink) return new Response("Not started", { status: 503 });
    const inbound = inboundOf(await request.json().catch(() => undefined));
    if (typeof inbound === "string") {
      this.logger.info({ reason: inbound }, "ignored a Telegram update");
    } else {
      await sink.accept(inbound);
    }
    return new Response();
  }
}

function sameSecret(given: string | null, expected: string): boolean {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** grammy errors hold the request URL, which holds the bot token. */
function safeError(method: string, error: unknown): Error {
  const reason =
    error instanceof GrammyError ? error.description : "network error";
  return new Error(`Telegram ${method} failed: ${reason}`);
}

/** Telegram answers 4xx only for a message it did not send. Other failures can come after the message was sent. */
function failedSend(error: unknown): SendResult {
  if (!(error instanceof GrammyError) || error.error_code >= 500) {
    return { status: "uncertain" };
  }
  if (error.error_code === 429) {
    const seconds = error.parameters.retry_after;
    return {
      status: "rejected",
      permanent: false,
      retryAfterMs: seconds === undefined ? undefined : seconds * 1000,
    };
  }
  return { status: "rejected", permanent: true };
}

registerChannel({
  kind: "telegram",
  envVar: "GATO_TELEGRAM_CONNECTIONS",
  schema: telegramSettings,
  create: (name, config, host) =>
    new TelegramAdapter(name, config, host.logger),
});
