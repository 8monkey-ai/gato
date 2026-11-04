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
import { plainText } from "./plain-text.ts";
import { realWait, startPolling, type Wait } from "./polling.ts";
import { readTelegramSettings, type TelegramSettings } from "./settings.ts";

function pollingBot(
  bot: Bot,
  sink: InboundSink,
  log: Logger,
  operatorChatId?: string,
) {
  bot.on("message", async (ctx) => {
    const message = ctx.message;
    if (String(message.chat.id) === operatorChatId) return;
    if (message.from?.is_bot) return;
    const event = inboundEvent(ctx.update, message);
    if (event) await sink(event);
  });
  // Rethrow so polling stops before Telegram confirms an update that was not saved.
  bot.catch((error) => {
    log.error("telegram.update_failed", { error: error.error });
    throw error;
  });
  return bot;
}

async function fetchFile(
  bot: Bot,
  token: string,
  fileId: string,
  cancel: AbortSignal,
) {
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(60_000)]);
  // grammy types the signal with its abort-controller shim; the runtime accepts a standard one.
  const shimSignal = signal as Parameters<Bot["api"]["getFile"]>[1];
  const { file_path } = await bot.api.getFile(fileId, shimSignal);
  if (!file_path) throw new Error("Telegram returned no file path");
  const response = await fetch(
    `https://api.telegram.org/file/bot${token}/${file_path}`,
    { signal },
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
  {
    newBot = (token: string) => new Bot(token),
    wait = realWait,
  }: { newBot?: (token: string) => Bot; wait?: Wait } = {},
): ChannelConnection {
  let instance: Bot | undefined;
  // Built on first use, so a missing token is reported by configuration checks first.
  const bot = () => (instance ??= newBot(settings.botToken));
  const { operatorChatId } = settings;
  let polling: Awaited<ReturnType<typeof startPolling>> | undefined;
  const send = (chatId: string, part: OutboundPart) =>
    sendOutcome(
      part.kind === "text"
        ? bot().api.sendMessage(chatId, plainText(part.text))
        : bot().api.sendVideo(chatId, part.url),
    );
  return {
    id,
    maxTextLength: 4096,
    supportsVideo: true,
    start: async (sink) => {
      polling = await startPolling({
        newBot: () =>
          pollingBot(newBot(settings.botToken), sink, log, operatorChatId),
        restartDelayMs: settings.pollRestartDelayMs,
        log,
        wait,
      });
    },
    stop: async () => {
      await polling?.stop();
    },
    healthy: () => polling?.healthy() ?? true,
    send,
    typing: async (chatId) => {
      await bot().api.sendChatAction(chatId, "typing");
    },
    fetchAttachment: (fileId, signal) =>
      fetchFile(bot(), settings.botToken, fileId, signal),
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
