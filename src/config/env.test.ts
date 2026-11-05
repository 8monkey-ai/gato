import { expect, test } from "bun:test";

import { parseDuration, readEnv } from "./env.ts";

test("parses compound durations", () => {
  expect(parseDuration("X", "12h35m")).toBe(45_300_000);
  expect(parseDuration("X", "750ms")).toBe(750);
  expect(() => parseDuration("X", "5 minutes")).toThrow(
    'Invalid X="5 minutes"',
  );
});

test("scoped readers prefix names and reject unknown choices", () => {
  const env = readEnv({ A_MODE: "b", A_LIST: "x, y,," }).scoped("A_");
  expect(env.list("LIST")).toEqual(["x", "y"]);
  expect(() => env.oneOf("MODE", ["a"])).toThrow(
    'Invalid A_MODE="b". Use one of: a.',
  );
});
