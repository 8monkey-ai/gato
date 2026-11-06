import { Bot, GrammyError } from "grammy";

import { errorText, log } from "../../log.ts";
import {
  type Channel,
  type ChannelSink,
  registerChannel,
  SendError,
} from "../channel.ts";
import { toIncoming } from "./convert.ts";

function sendError(error: unknown): SendError {
  if (error instanceof GrammyError) {
    if (error.error_code === 429)
      return new SendError(
        "rejected",
        error.description,
        (error.parameters.retry_after ?? 1) * 1000,
      );
    if (error.error_code < 500)
      return new SendError("failed", error.description);
  }
  return new SendError("uncertain", errorText(error));
}

async function sent(request: Promise<{ message_id: number }>): Promise<string> {
  try {
    return String((await request).message_id);
  } catch (error) {
    throw sendError(error);
  }
}

/** A standard bot: no assignment, no operator inbox, no internal notes, no handoff. */
class TelegramChannel implements Channel {
  readonly name = "telegram";
  readonly textLimit = 4096;
  readonly routes = {};
  private readonly bot: Bot;

  constructor(
    private readonly token: string,
    private readonly apiRoot: string,
  ) {
    this.bot = new Bot(token, { client: { apiRoot, timeoutSeconds: 30 } });
  }

  async start(sink: ChannelSink) {
    this.bot.on("message", (context) =>
      sink.receive(String(context.chat.id), toIncoming(context.message)),
    );
    this.bot.catch((error) =>
      log.error("telegram.update_failed", { error: errorText(error.error) }),
    );
    await this.bot.init();
    this.bot
      .start({ allowed_updates: ["message"] })
      .catch((error: unknown) =>
        log.error("telegram.polling_stopped", { error: errorText(error) }),
      );
  }

  async stop() {
    await this.bot.stop();
  }

  agentOwns() {
    return Promise.resolve(true);
  }

  async download(source: string) {
    const file = await this.bot.api.getFile(source);
    if (!file.file_path) throw new Error("Telegram gave no file path");
    const response = await fetch(
      `${this.apiRoot}/file/bot${this.token}/${file.file_path}`,
      {
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!response.ok)
      throw new Error(`Telegram file download answered ${response.status}`);
    return {
      data: await response.bytes(),
      mime: response.headers.get("content-type") ?? undefined,
    };
  }

  sendText(conversation: string, text: string) {
    return sent(this.bot.api.sendMessage(conversation, text));
  }

  sendVideo(conversation: string, url: string) {
    return sent(this.bot.api.sendVideo(conversation, url));
  }

  async showTyping(conversation: string) {
    await this.bot.api.sendChatAction(conversation, "typing");
  }
}

registerChannel({
  name: "telegram",
  create(env) {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token)
      throw new Error(
        "TELEGRAM_BOT_TOKEN is required when CHANNELS includes telegram",
      );
    return new TelegramChannel(
      token,
      env.TELEGRAM_API_BASE_URL || "https://api.telegram.org",
    );
  },
});
