import { afterEach, beforeEach } from "bun:test";

import type { RunningApp } from "./app.ts";
import { startApp } from "./app.ts";
import type { FakeGateway } from "./gateway.ts";
import { startFakeGateway } from "./gateway.ts";
import { agentUserId, FakeRespondIo, signingKey } from "./respondio.ts";
import { createSkillsRepo } from "./skills.ts";
import { FakeTelegram } from "./telegram.ts";

export interface Harness {
  skillsDir: string;
  gateway: FakeGateway;
  telegram: FakeTelegram;
  respond: FakeRespondIo;
  app: RunningApp;
  env(): Record<string, string>;
  start(extra?: Record<string, string>): Promise<RunningApp>;
  restart(extra?: Record<string, string>): Promise<RunningApp>;
}

type Connection = "tg" | "rio";

function connectionEnv(
  harness: Harness,
  connections: Connection[],
): Record<string, string> {
  const env: Record<string, string> = { CONNECTIONS: connections.join(",") };
  if (connections.includes("tg")) {
    Object.assign(env, {
      CONNECTION_TG_TYPE: "telegram",
      CONNECTION_TG_BOT_TOKEN: harness.telegram.token,
      CONNECTION_TG_API_ROOT: harness.telegram.apiRoot,
    });
  }
  if (connections.includes("rio")) {
    Object.assign(env, {
      CONNECTION_RIO_TYPE: "respondio",
      CONNECTION_RIO_API_TOKEN: "rio-token",
      CONNECTION_RIO_API_URL: harness.respond.url,
      CONNECTION_RIO_WEBHOOK_SIGNING_KEYS: `other-key,${signingKey}`,
      CONNECTION_RIO_AGENT_USER_ID: String(agentUserId),
    });
  }
  return env;
}

export function baseEnv(harness: Harness, connections: Connection[]) {
  return {
    COUNTRY: "MY",
    MODEL: "test/base",
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_BASE_URL: harness.gateway.url,
    DELIVERY_PAUSE: "10ms",
    SKILLS_DIR: harness.skillsDir,
    ...connectionEnv(harness, connections),
  };
}

export function useHarness(
  connections: Connection[] = ["tg"],
  base: () => Record<string, string> = () => ({}),
) {
  const harness = {} as Harness;
  let lastEnv: Record<string, string> = {};
  beforeEach(async () => {
    harness.skillsDir = await createSkillsRepo();
    harness.gateway = startFakeGateway();
    harness.telegram = new FakeTelegram();
    harness.respond = new FakeRespondIo();
    harness.env = () => ({ ...baseEnv(harness, connections), ...base() });
    harness.start = async (extra = {}) => {
      lastEnv = { ...harness.env(), ...extra };
      harness.app = await startApp(lastEnv);
      return harness.app;
    };
    harness.restart = async (extra = {}) => {
      await harness.app.stop();
      lastEnv = { ...lastEnv, DATA_DIR: harness.app.dataDir, ...extra };
      harness.app = await startApp(lastEnv);
      return harness.app;
    };
  });
  afterEach(async () => {
    await harness.app?.stop();
    await Promise.all([
      harness.gateway.stop(),
      harness.telegram.stop(),
      harness.respond.stop(),
    ]);
    (harness as Partial<Harness>).app = undefined;
  });
  return harness;
}

export const useTelegram = (base?: () => Record<string, string>) =>
  useHarness(["tg"], base);
