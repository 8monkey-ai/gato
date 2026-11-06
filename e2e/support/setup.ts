import { afterEach } from "bun:test";

import {
  type App,
  defaultSkills,
  startApp,
  tempDir,
  writeFiles,
} from "./app.ts";
import { fakeGateway } from "./fake-gateway.ts";
import { fakeTelegram, telegramToken } from "./fake-telegram.ts";

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export function onCleanup(cleanup: () => unknown) {
  cleanups.push(cleanup);
}

export const agentModel = "test/agent";

/** A Telegram-only harness with fakes for Telegram and the model gateway. */
export async function telegramHarness(
  env: Record<string, string> = {},
  options: {
    skills?: Record<string, string>;
    dataDir?: string;
    models?: string[];
  } = {},
) {
  const gateway = fakeGateway([agentModel, ...(options.models ?? [])]);
  const telegram = fakeTelegram();
  onCleanup(() => gateway.stop());
  onCleanup(() => telegram.stop());
  const dataDir = options.dataDir ?? (await tempDir("data"));
  const skillsDir = await writeFiles(
    await tempDir("skills"),
    options.skills ?? defaultSkills,
  );
  const baseEnv = {
    DATA_DIR: dataDir,
    SKILLS_DIR: skillsDir,
    COUNTRY: "MY",
    CHANNELS: "telegram",
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_BASE_URL: gateway.url,
    AGENT_MODEL: agentModel,
    TELEGRAM_BOT_TOKEN: telegramToken,
    TELEGRAM_API_BASE_URL: telegram.url,
    DELIVERY_PACING: "none",
    NUDGE_ENABLED: "false",
    ...env,
  };
  const start = async (extra: Record<string, string> = {}) => {
    const app = await startApp({ ...baseEnv, ...extra });
    onCleanup(() => app.stop());
    return app;
  };
  const app = await start();
  return { app, gateway, telegram, dataDir, skillsDir, env: baseEnv, start };
}

export type { App };
