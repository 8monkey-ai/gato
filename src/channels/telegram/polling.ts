import { setTimeout as sleep } from "node:timers/promises";

import type { Bot } from "grammy";

import type { Logger } from "../../log.ts";

export type Wait = (ms: number, signal: AbortSignal) => Promise<unknown>;

export const realWait: Wait = (ms, signal) => sleep(ms, undefined, { signal });

type PollingOptions = {
  newBot: () => Bot; // a fresh bot, so a restart fetches the unconfirmed update again
  restartDelayMs: number;
  log: Logger;
  wait: Wait;
};

export async function startPolling(options: PollingOptions) {
  const { newBot, restartDelayMs, log, wait } = options;
  const stopping = new AbortController();
  let failed = false;
  let bot = newBot();
  await bot.init();
  const onStart = () => {
    if (!failed) return;
    failed = false;
    log.info("telegram.polling_restarted");
  };
  const keepPolling = async () => {
    for (;;) {
      const error = await bot.start({ onStart }).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      if (stopping.signal.aborted) return;
      failed = true;
      log.error("telegram.polling_stopped", { error, restartDelayMs });
      await wait(restartDelayMs, stopping.signal).catch(() => undefined);
      if (stopping.signal.aborted) return;
      bot = newBot();
    }
  };
  void keepPolling();
  return {
    healthy: () => !failed,
    stop: async () => {
      stopping.abort();
      await bot.stop();
    },
  };
}
