import { Bot } from "grammy";

import type { Logger } from "../../log.ts";
import type {
  ChannelConnection,
  InboundSink,
  OutboundPart,
} from "../channel.ts";
import { registerChannelType } from "../registry.ts";
import { inboundEvent } from "./inbound.ts";
import { sendOutcome } from "./outbound.ts";
import { readTelegramSettings, type TelegramSettings } from "./settings.ts";

function listen(bot: Bot, sink: InboundSink, operatorChatId?: string) {
  bot.on("message", async (ctx) => {
    const message = ctx.message;
    if (String(message.chat.id) === operatorChatId) return;
    if (message.from?.is_bot) return;
    const event = inboundEvent(ctx.update, message);
    if (event) await sink(event);
  });
}

async function startPolling(bot: Bot, log: Logger) {
  // Rethrow so polling stops before Telegram confirms an update that was not saved.
  bot.catch((error) => {
    log.error("telegram.update_failed", { error: error.error });
    throw error;
  });
  await bot.init();
  bot.start().catch((error: unknown) => {
    log.error("telegram.polling_stopped", { error });
  });
}

async function fetchFile(bot: Bot, token: string, fileId: string) {
  const { file_path } = await bot.api.getFile(fileId);
  if (!file_path) throw new Error("Telegram returned no file path");
  const response = await fetch(
    `https://api.telegram.org/file/bot${token}/${file_path}`,
  ).catch(() => {
    throw new Error("Telegram file download failed");
  });
  if (!response.ok)
    throw new Error(`Telegram file download failed: ${response.status}`);
  return { bytes: new Uint8Array(await response.arrayBuffer()) };
}

async function contactContext(
  bot: Bot,
  chatId: string,
): Promise<Record<string, string>> {
  const chat = await bot.api.getChat(chatId);
  const name =
    chat.type === "private"
      ? [chat.first_name, chat.last_name].filter(Boolean).join(" ")
      : chat.title;
  return name ? { name } : {};
}

export function createTelegramConnection(
  id: string,
  settings: TelegramSettings,
  log: Logger,
  newBot = (token: string) => new Bot(token),
): ChannelConnection {
  let instance: Bot | undefined;
  // Built on first use, so a missing token is reported by configuration checks first.
  const bot = () => (instance ??= newBot(settings.botToken));
  const { operatorChatId } = settings;
  const send = (chatId: string, part: OutboundPart) =>
    sendOutcome(
      part.kind === "text"
        ? bot().api.sendMessage(chatId, part.text)
        : bot().api.sendVideo(chatId, part.url),
    );
  return {
    id,
    maxTextLength: 4096,
    supportsVideo: true,
    start: (sink) => {
      listen(bot(), sink, operatorChatId);
      return startPolling(bot(), log);
    },
    stop: () => bot().stop(),
    send,
    typing: async (chatId) => {
      await bot().api.sendChatAction(chatId, "typing");
    },
    fetchAttachment: (fileId) => fetchFile(bot(), settings.botToken, fileId),
    contactContext: (chatId) => contactContext(bot(), chatId).catch(() => ({})),
    ...(operatorChatId && {
      notifyOperators: async (chatId: string, text: string) => {
        await bot().api.sendMessage(operatorChatId, `Chat ${chatId}: ${text}`);
      },
    }),
  };
}

registerChannelType({
  type: "telegram",
  create: (id, env, log) =>
    Promise.resolve(
      createTelegramConnection(id, readTelegramSettings(env), log),
    ),
});
