import { setTimeout as sleep } from "node:timers/promises";

import { Api, GrammyError } from "grammy";

import { envList } from "../../env.ts";
import { log, protectSecret } from "../../log.ts";
import {
  type ChannelFactory,
  type Connection,
  type Outgoing,
  type Receiver,
  SendError,
} from "../channel.ts";
import { toIncoming } from "./updates.ts";

export const telegram: ChannelFactory = async (env) => {
  const apiRoot = env.TELEGRAM_API_URL ?? "https://api.telegram.org";
  return Promise.all(
    envList(env.TELEGRAM_BOT_TOKENS).map((token) => connect(token, apiRoot)),
  );
};

async function connect(token: string, apiRoot: string): Promise<Connection> {
  protectSecret(token);
  const api = new Api(token, { apiRoot, timeoutSeconds: 60 });
  const me = await api.getMe();
  const stopping = new AbortController();
  const { promise: reconciled, resolve: setReconciled } =
    Promise.withResolvers<void>();
  let polling: Promise<void> = Promise.resolve();
  const connection: Connection = {
    id: `telegram-${me.id}`,
    label: "Telegram",
    maxTextLength: 4096,
    media: new Set(["image", "video", "audio", "document"]),
    routes: {},
    reconciled,
    start(receive) {
      polling = poll(api, connection, receive, stopping.signal, setReconciled);
      return Promise.resolve();
    },
    async stop() {
      stopping.abort();
      await polling;
    },
    isAgentOwned: () => Promise.resolve(true),
    send: (chat, message) => send(api, chat, message),
    async download(fileId) {
      const file = await api.getFile(fileId);
      const response = await fetch(
        `${apiRoot}/file/bot${token}/${file.file_path}`,
        {
          signal: AbortSignal.timeout(60_000),
        },
      );
      if (!response.ok)
        throw new Error(
          `Telegram file download failed with HTTP ${response.status}`,
        );
      return { bytes: await response.bytes() };
    },
    async typing(chat) {
      await api.sendChatAction(chat, "typing");
    },
  };
  return connection;
}

async function poll(
  api: Api,
  connection: Connection,
  receive: Receiver,
  signal: AbortSignal,
  setReconciled: () => void,
) {
  let offset = 0;
  while (!signal.aborted) {
    try {
      const updates = await api.getUpdates(
        { offset, timeout: 30, allowed_updates: ["message"] },
        signal as Parameters<Api["getUpdates"]>[1],
      );
      for (const update of updates) {
        const message = toIncoming(update);
        if (message) await receive(connection, message);
        offset = update.update_id + 1;
      }
      if (updates.length < 100) setReconciled();
    } catch (error) {
      if (signal.aborted) return;
      log.error("telegram.poll_failed", { connection: connection.id, error });
      await sleep(5000, undefined, { signal }).catch(() => undefined);
    }
  }
}

async function send(
  api: Api,
  chat: string,
  message: Outgoing,
): Promise<string> {
  try {
    const sent =
      "text" in message
        ? await api.sendMessage(chat, message.text)
        : message.media === "image"
          ? await api.sendPhoto(chat, message.url)
          : message.media === "video"
            ? await api.sendVideo(chat, message.url)
            : message.media === "audio"
              ? await api.sendAudio(chat, message.url)
              : await api.sendDocument(chat, message.url);
    return String(sent.message_id);
  } catch (error) {
    if (!(error instanceof GrammyError))
      throw new SendError("Telegram did not answer", "uncertain");
    if (error.error_code === 429) {
      throw new SendError(
        error.description,
        "temporary",
        (error.parameters.retry_after ?? 1) * 1000,
      );
    }
    throw new SendError(
      error.description,
      error.error_code >= 500 ? "uncertain" : "refused",
    );
  }
}
