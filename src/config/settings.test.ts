import { expect, test } from "bun:test";

import { ConfigError, createEnvReader } from "./env.ts";
import { readSettings } from "./settings.ts";

const required = {
  GATO_DATA_DIR: "/data",
  GATO_SKILLS_DIR: "/skills",
  GATO_COUNTRY: "PH",
  OPENROUTER_API_KEY: "k",
  GATO_MODEL: "base/model",
  GATO_CONNECTIONS: "tg-main",
  GATO_CONNECTION_TG_MAIN_TYPE: "telegram",
};

function settingsFor(vars: Record<string, string>) {
  const env = createEnvReader(vars);
  const settings = readSettings(env);
  env.assertValid();
  return settings;
}

test("applies the documented defaults", () => {
  const s = settingsFor(required);
  expect(s.port).toBe(3000);
  expect(s.timeZone).toBe("UTC");
  expect(s.summaryModel).toBe("base/model");
  expect(s.summaryPromptFile).toBeUndefined();
  expect(s.preparationModels).toEqual({
    image: undefined,
    document: undefined,
    audio: undefined,
  });
  expect(s.turn).toEqual({ timeoutMs: 120000, maxModelCalls: 12 });
  expect(s.ownershipPolicy).toBe("assigned");
  expect(s.history).toEqual({ scope: "chat", includeToolActivity: true });
});

test("applies the documented delivery and nudge defaults", () => {
  const s = settingsFor(required);
  expect(s.delivery).toEqual({
    boundary: "paragraph",
    timing: "stream",
    pacing: "fixed",
    pauseMs: 750,
    perWordMs: 1000,
    stripFinalStop: true,
    video: {
      linkPrefixes: [],
      mode: "attachment",
      surroundingText: "replace",
    },
  });
  expect(s.nudges).toEqual({
    enabled: true,
    expiryEnabled: true,
    checkIntervalMs: 300000,
    concurrency: 4,
    milestonesMs: [300000, 2100000, 45300000, 45900000],
    hours: { startMinutes: 0, endMinutes: 1440 },
    prompt: "Nudge",
    expiryAfterMs: 49500000,
    expiryExemptLabel: "out-of-scope-unsolved",
  });
  expect(s.labels).toEqual({
    handoff: "handoff",
    outOfScope: "out-of-scope",
    error: "error",
    expired: "expired",
  });
  expect(s.shutdownGraceMs).toBe(10000);
  expect(s.opsToken).toBeUndefined();
  expect(s.connections).toEqual([{ id: "tg-main", type: "telegram" }]);
  expect(s.mcpServers).toEqual([]);
});

test("reads configured values", () => {
  const s = settingsFor({
    ...required,
    GATO_TIMEZONE: "Asia/Manila",
    GATO_NUDGE_HOURS: "08:30-20:00",
    GATO_NUDGE_MILESTONES: "1m, 2h",
    GATO_MCP_SERVERS: "crm,docs",
    GATO_NUDGE_CONCURRENCY: "2",
  });
  expect(s.timeZone).toBe("Asia/Manila");
  expect(s.nudges.hours).toEqual({ startMinutes: 510, endMinutes: 1200 });
  expect(s.nudges.milestonesMs).toEqual([60000, 7200000]);
  expect(s.mcpServers).toEqual(["crm", "docs"]);
  expect(s.nudges.concurrency).toBe(2);
});

test("reports every invalid variable in one error", () => {
  const env = createEnvReader({
    GATO_COUNTRY: "SG",
    GATO_TIMEZONE: "Mars/Base",
    GATO_NUDGE_HOURS: "20:00-20:00",
    GATO_CONNECTIONS: "a,b",
    GATO_CONNECTION_A_TYPE: "telegram",
  });
  readSettings(env);
  let message = "";
  try {
    env.assertValid();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    message = (error as Error).message;
  }
  for (const name of [
    "GATO_DATA_DIR: required",
    "GATO_SKILLS_DIR: required",
    'GATO_COUNTRY: "SG" is not valid; accepted: MY, PH',
    'GATO_TIMEZONE: "Mars/Base" is not valid',
    "OPENROUTER_API_KEY: required",
    "GATO_MODEL: required",
    'GATO_NUDGE_HOURS: "20:00-20:00" is not valid',
    "GATO_CONNECTION_B_TYPE: required",
  ])
    expect(message).toContain(name);
  expect(message).not.toContain("GATO_CONNECTION_A_TYPE");
});

test("accepts nudge hours that cross midnight", () => {
  const s = readSettings(createEnvReader({ GATO_NUDGE_HOURS: "20:00-08:00" }));
  expect(s.nudges.hours).toEqual({ startMinutes: 1200, endMinutes: 480 });
});
