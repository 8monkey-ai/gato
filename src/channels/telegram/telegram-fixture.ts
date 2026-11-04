import { Bot } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";

import { createLogger } from "../../log.ts";
import { createTelegramConnection } from "./index.ts";
import type { Wait } from "./polling.ts";

export type Answer = (method: string) => unknown;

const botInfo = {
  id: 1,
  is_bot: true,
  first_name: "Gato",
  username: "gato_bot",
} as UserFromGetMe;

type AbortSignalLike = {
  aborted: boolean;
  addEventListener(type: "abort", listener: () => void): void;
};

function waitForAbort(signal: AbortSignalLike) {
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve({ ok: true, result: [] })),
  );
}

type FakeOptions = {
  operatorChatId?: string;
  answer?: Answer;
  updates?: Update[];
  wait?: Wait;
};

export function telegramFake(options: FakeOptions) {
  const calls: { method: string; payload: unknown }[] = [];
  const signals = new Map<string, AbortSignalLike>();
  const logs: string[] = [];
  const bots: Bot[] = [];
  let pending = options.updates ?? [];
  // Like Telegram: an offset confirms the updates before it, others come back until confirmed.
  const getUpdates = (payload: unknown, signal?: AbortSignalLike) => {
    const { offset = 0 } = payload as { offset?: number };
    pending = pending.filter((update) => update.update_id >= offset);
    if (pending.length > 0) return { ok: true, result: pending };
    return signal ? waitForAbort(signal) : { ok: true, result: [] };
  };
  const newBot = () => {
    const bot = new Bot("123:SECRET", { botInfo });
    bot.api.config.use((_prev, method, payload, signal) => {
      if (method === "getUpdates")
        return Promise.resolve(getUpdates(payload, signal) as never);
      calls.push({ method, payload });
      if (signal) signals.set(method, signal);
      return Promise.resolve(
        (options.answer?.(method) ?? {
          ok: true,
          result: true,
        }) as never,
      );
    });
    bots.push(bot);
    return bot;
  };
  const connection = createTelegramConnection(
    "tg",
    {
      botToken: "123:SECRET",
      operatorChatId: options.operatorChatId,
      pollRestartDelayMs: 5000,
    },
    createLogger({}, (line) => logs.push(line)),
    { newBot, wait: options.wait },
  );
  const events = () =>
    logs.map((line) => (JSON.parse(line) as { event: string }).event);
  return { bots, calls, signals, events, connection };
}
