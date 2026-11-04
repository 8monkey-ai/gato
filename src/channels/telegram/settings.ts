import type { EnvReader } from "../../config/env.ts";

export type TelegramSettings = {
  botToken: string;
  operatorChatId?: string;
};

export function readTelegramSettings(env: EnvReader): TelegramSettings {
  return {
    botToken: env.string("BOT_TOKEN"),
    operatorChatId: env.optionalString("OPERATOR_CHAT_ID"),
  };
}
