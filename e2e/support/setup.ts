import { afterEach } from "bun:test";

import {
  type App,
  defaultSkills,
  startApp,
  tempDir,
  writeFiles,
} from "./app.ts";
import { fakeGateway } from "./fake-gateway.ts";
import { agentUserId, fakeRespondio, signingKey } from "./fake-respondio.ts";
import { fakeTelegram, telegramToken } from "./fake-telegram.ts";

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export function onCleanup(cleanup: () => unknown) {
  cleanups.push(cleanup);
}

export const agentModel = "test/agent";

interface HarnessOptions {
  channels?: string;
  env?: Record<string, string>;
  skills?: Record<string, string>;
  dataDir?: string;
  models?: string[];
  /** Files written into the data folder before start, as external migration would. */
  data?: Record<string, string>;
}

function channelEnv(telegramUrl: string, respondioUrl: string) {
  return {
    TELEGRAM_BOT_TOKEN: telegramToken,
    TELEGRAM_API_BASE_URL: telegramUrl,
    RESPONDIO_API_TOKEN: "respondio-token",
    RESPONDIO_API_BASE_URL: respondioUrl,
    RESPONDIO_WEBHOOK_SIGNING_KEY: signingKey,
    RESPONDIO_AGENT_USER_ID: String(agentUserId),
  };
}

/** Starts the harness with fakes for Telegram, respond.io, and the model gateway. */
export async function startHarness(options: HarnessOptions = {}) {
  const gateway = fakeGateway([agentModel, ...(options.models ?? [])]);
  const telegram = fakeTelegram();
  const respondio = fakeRespondio();
  onCleanup(() => gateway.stop());
  onCleanup(() => telegram.stop());
  onCleanup(() => respondio.stop());
  const dataDir =
    options.dataDir ??
    (await writeFiles(await tempDir("data"), options.data ?? {}));
  const skillsDir = await writeFiles(
    await tempDir("skills"),
    options.skills ?? defaultSkills,
  );
  const env: Record<string, string> = {
    DATA_DIR: dataDir,
    SKILLS_DIR: skillsDir,
    COUNTRY: "MY",
    CHANNELS: options.channels ?? "telegram",
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_BASE_URL: gateway.url,
    AGENT_MODEL: agentModel,
    ...channelEnv(telegram.url, respondio.url),
    DELIVERY_PACING: "none",
    NUDGE_ENABLED: "false",
    ...options.env,
  };
  const start = async (extra: Record<string, string> = {}) => {
    const app = await startApp({ ...env, ...extra });
    onCleanup(() => app.stop());
    return app;
  };
  const app = await start();
  return { app, gateway, telegram, respondio, dataDir, skillsDir, env, start };
}

export type { App };
