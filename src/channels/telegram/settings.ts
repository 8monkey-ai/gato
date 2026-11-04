import type { EnvReader } from "../../config/env.ts";

export type TelegramSettings = {
  botToken: string;
  operatorChatId?: string;
  pollRestartDelayMs: number;
};

export function readTelegramSettings(env: EnvReader): TelegramSettings {
  return {
    botToken: env.string("BOT_TOKEN"),
    operatorChatId: env.optionalString("OPERATOR_CHAT_ID"),
    pollRestartDelayMs: env.duration("POLL_RESTART_DELAY", { default: "5s" }),
  };
}
