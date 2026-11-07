import { type App, startApp, tempDir, writeSkills } from "./app.ts";
import { startFakeOpenRouter } from "./fake-openrouter.ts";
import { type FakeRespondio, startFakeRespondio } from "./fake-respondio.ts";
import { type FakeTelegram, startFakeTelegram } from "./fake-telegram.ts";

export type World = Awaited<ReturnType<typeof createWorld>>;

function environments(
  llmUrl: string,
  dataDir: string,
  skillsDir: string,
  telegram: FakeTelegram,
  respondio: FakeRespondio,
) {
  return {
    baseEnv: {
      CONVERSATIONS_DIR: dataDir,
      SKILLS_DIR: skillsDir,
      AGENT_COUNTRY: "MY",
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_BASE_URL: llmUrl,
      AGENT_MODEL: "test/agent",
      HTTP_PORT: "0",
      DELIVERY_PACING: "none",
      NUDGES_ENABLED: "false",
    } as Record<string, string>,
    telegramEnv: {
      TELEGRAM_BOT_TOKENS: telegram.token,
      TELEGRAM_API_URL: telegram.apiUrl,
    },
    respondioEnv: {
      RESPONDIO_WORKSPACES: "main",
      RESPONDIO_API_URL: respondio.apiUrl,
      RESPONDIO_MAIN_API_TOKEN: "test-respondio-token",
      RESPONDIO_MAIN_WEBHOOK_SIGNING_KEYS: respondio.signingKey,
      RESPONDIO_MAIN_AGENT_USER_ID: "77",
    },
  };
}

export async function createWorld(
  options: { skills?: Record<string, string> } = {},
) {
  const llm = startFakeOpenRouter();
  const telegram = startFakeTelegram();
  const respondio = startFakeRespondio();
  const dataDir = await tempDir("gato-data-");
  const skillsDir = await writeSkills(options.skills);
  const apps: App[] = [];
  const env = environments(
    llm.baseUrl,
    dataDir,
    skillsDir,
    telegram,
    respondio,
  );
  return {
    llm,
    telegram,
    respondio,
    dataDir,
    skillsDir,
    ...env,
    async start(
      extra: Record<string, string> = {},
      channels: "telegram" | "respondio" | "both" = "telegram",
    ) {
      const app = await startApp({
        ...env.baseEnv,
        ...(channels !== "respondio" ? env.telegramEnv : {}),
        ...(channels !== "telegram" ? env.respondioEnv : {}),
        ...extra,
      });
      apps.push(app);
      return app;
    },
    async close() {
      await Promise.all(apps.map((app) => app.stop()));
      await Promise.all([llm.stop(), telegram.stop(), respondio.stop()]);
    },
  };
}
