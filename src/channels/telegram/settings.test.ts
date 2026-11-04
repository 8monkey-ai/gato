import { expect, test } from "bun:test";

import { createEnvReader } from "../../config/env.ts";
import { readTelegramSettings } from "./settings.ts";

test("restarts polling after five seconds unless configured", () => {
  const delay = (vars: Record<string, string>) =>
    readTelegramSettings(createEnvReader({ BOT_TOKEN: "t", ...vars }))
      .pollRestartDelayMs;
  expect(delay({})).toBe(5000);
  expect(delay({ POLL_RESTART_DELAY: "750ms" })).toBe(750);
});
