import { Bot, GrammyError, HttpError } from "grammy";

import type { Env } from "../../config/env.ts";
import { errorText } from "../../log.ts";
import type { Channel, Inbox, OutgoingPart, SendResult } from "../channel.ts";
import { registerChannelType } from "../channel.ts";
import { download } from "../download.ts";
import { customerEvent, operatorCommand } from "./parse.ts";

function sendFailure(error: unknown): SendResult {
  if (error instanceof GrammyError) {
    if (error.error_code === 429) {
      const seconds = error.parameters.retry_after ?? 1;
      return { status: "retry", afterMs: seconds * 1000 };
    }
    return { status: "rejected", reason: error.description };
  }
  const reason = error instanceof HttpError ? error.message : errorText(error);
  return { status: "uncertain", reason };
}

async function send(
  bot: Bot,
  chat: string,
  part: OutgoingPart,
): Promise<SendResult> {
  try {
    const sent =
      "text" in part
        ? await bot.api.sendMessage(chat, part.text)
        : await bot.api.sendVideo(chat, part.videoUrl);
    return { status: "sent", ref: String(sent.message_id) };
  } catch (error) {
    return sendFailure(error);
  }
}

function listen(bot: Bot, inbox: Inbox, operatorChat: string | undefined) {
  bot.on("message", async (context) => {
    const message = context.message;
    if (operatorChat && String(message.chat.id) === operatorChat) {
      const command = message.text ? operatorCommand(message.text) : undefined;
      if (command) await inbox.handle(command);
      return;
    }
    if (message.from?.is_bot) return;
    const event = customerEvent(message);
    if (event) await inbox.handle(event);
  });
}

async function retrieve(bot: Bot, apiRoot: string, fileId: string) {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram gave no file path.");
  const { data } = await download(
    `${apiRoot}/file/bot${bot.token}/${file.file_path}`,
  );
  return { data };
}

function createTelegram(_name: string, env: Env): Channel {
  const apiRoot = env.string("API_ROOT", "https://api.telegram.org");
  const operatorChat = env.optional("OPERATOR_CHAT_ID");
  const bot = new Bot(env.string("BOT_TOKEN"), {
    client: { apiRoot, timeoutSeconds: 60 },
  });
  const notify = async (chat: string, text: string) => {
    if (operatorChat)
      await bot.api.sendMessage(operatorChat, `Chat ${chat}: ${text}`);
  };
  return {
    maxMessageLength: 4096,
    nativeAssignment: false,
    videoAttachments: true,
    routes: {},
    async start(inbox) {
      listen(bot, inbox, operatorChat);
      await bot.init();
      bot.start().catch((error: unknown) => inbox.fail(error));
    },
    async stop() {
      if (bot.isRunning()) await bot.stop();
    },
    send: (chat, part) => send(bot, chat, part),
    retrieve: (fileId) => retrieve(bot, apiRoot, fileId),
    typing: async (chat) => void (await bot.api.sendChatAction(chat, "typing")),
    ...(operatorChat && { notifyOperators: notify }),
  };
}

registerChannelType("telegram", createTelegram);
