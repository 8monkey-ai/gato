import { expect, test } from "bun:test";

import { parseDuration, readConfig } from "./config.ts";

const required = {
  DATA_DIR: "/data",
  SKILLS_DIR: "/skills",
  COUNTRY: "MY",
  CHANNELS: "telegram",
  OPENROUTER_API_KEY: "key",
  AGENT_MODEL: "a/b",
};

test("defaults follow the specification", () => {
  const config = readConfig(required);
  expect(config.TURN_TIMEOUT_SECONDS).toBe(120_000);
  expect(config.NUDGE_CHECK_INTERVAL_SECONDS).toBe(300_000);
  expect(config.NUDGE_MILESTONES).toEqual([
    300_000, 2_100_000, 45_300_000, 45_900_000,
  ]);
  expect(config.NUDGE_HOURS).toEqual({ from: 0, to: 1440 });
  expect(config.DELIVERY_MESSAGE_BOUNDARY).toBe("\n\n");
  expect(config.TIMEZONE).toBe("UTC");
  expect(config.COUNTRY).toBe("my");
});

test("durations and empty values", () => {
  expect(parseDuration("12h35m")).toBe(45_300_000);
  expect(() => parseDuration("5 minutes")).toThrow("not a duration");
  expect(
    readConfig({ ...required, SUMMARY_MODEL: "" }).SUMMARY_MODEL,
  ).toBeUndefined();
});

test("problems name the setting", () => {
  expect(() => readConfig({ ...required, COUNTRY: "SG" })).toThrow(
    "COUNTRY: must be MY (Malaysia) or PH (the Philippines)",
  );
});
