import { afterEach, beforeEach } from "bun:test";

import type { RunningApp } from "./app.ts";
import { startApp } from "./app.ts";
import type { FakeGateway } from "./gateway.ts";
import { startFakeGateway } from "./gateway.ts";
import { telegramEnv } from "./setup.ts";
import type { FakeTelegram } from "./telegram.ts";
import { startFakeTelegram } from "./telegram.ts";

export interface TelegramFixture {
  gateway: FakeGateway;
  telegram: FakeTelegram;
  app: RunningApp;
  start(extra?: Record<string, string>): Promise<RunningApp>;
  restart(extra?: Record<string, string>): Promise<RunningApp>;
}

export function useTelegram(base: () => Record<string, string> = () => ({})) {
  const fixture = {} as TelegramFixture;
  let lastEnv: Record<string, string> = {};
  beforeEach(() => {
    fixture.gateway = startFakeGateway();
    fixture.telegram = startFakeTelegram();
    fixture.start = async (extra = {}) => {
      lastEnv = {
        ...telegramEnv(fixture.gateway, fixture.telegram),
        ...base(),
        ...extra,
      };
      fixture.app = await startApp(lastEnv);
      return fixture.app;
    };
    fixture.restart = async (extra = {}) => {
      await fixture.app.stop();
      lastEnv = { ...lastEnv, DATA_DIR: fixture.app.dataDir, ...extra };
      fixture.app = await startApp(lastEnv);
      return fixture.app;
    };
  });
  afterEach(async () => {
    await fixture.app?.stop();
    await fixture.gateway.stop();
    await fixture.telegram.stop();
    (fixture as Partial<TelegramFixture>).app = undefined;
  });
  return fixture;
}
