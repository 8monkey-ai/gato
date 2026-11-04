import { expect, test } from "bun:test";

import { ConfigError, createEnvReader, envId } from "./env.ts";

test("parses durations to milliseconds", () => {
  const env = createEnvReader({
    A: "750ms",
    B: "2s",
    C: "5m",
    D: "12h35m",
    E: "1h",
    F: "1h2m3s4ms",
  });
  expect(["A", "B", "C", "D", "E", "F"].map((n) => env.duration(n))).toEqual([
    750, 2000, 300000, 45300000, 3600000, 3723004,
  ]);
  env.assertValid();
});

test("applies defaults and treats empty values as unset", () => {
  const env = createEnvReader({ EMPTY: "", LIST: " a, b ,,c " });
  expect(env.string("EMPTY", { default: "x" })).toBe("x");
  expect(env.optionalString("EMPTY")).toBeUndefined();
  expect(env.int("MISSING", { default: 3 })).toBe(3);
  expect(env.bool("MISSING", { default: true })).toBe(true);
  expect(env.duration("MISSING", { default: "10s" })).toBe(10000);
  expect(env.list("LIST")).toEqual(["a", "b", "c"]);
  expect(env.list("EMPTY", { default: [] })).toEqual([]);
  expect(env.enumOf("MISSING", ["x", "y"], "y")).toBe("y");
  env.assertValid();
});

test("reads prefixed names through a scope", () => {
  const env = createEnvReader({ GATO_CONNECTION_TG_BOT_TOKEN: "t" });
  expect(env.scope("GATO_CONNECTION_").scope("TG_").string("BOT_TOKEN")).toBe(
    "t",
  );
});

test("reads unprefixed names from the root of a scope and reports them together", () => {
  const env = createEnvReader({ GATO_LABEL_HANDOFF: "human" });
  const scoped = env.scope("GATO_CONNECTION_TG_");
  expect(scoped.root().string("GATO_LABEL_HANDOFF")).toBe("human");
  scoped.root().string("MISSING");
  expect(() => env.assertValid()).toThrow("MISSING: required");
});

test("collects every problem into one ConfigError", () => {
  const env = createEnvReader({
    D: "5 minutes",
    I: "-1",
    B: "yes",
    E: "z",
    S_X: "nope",
  });
  env.duration("D");
  env.int("I");
  env.bool("B");
  env.enumOf("E", ["x", "y"]);
  env.string("REQUIRED");
  env.scope("S_").int("X");
  expect(() => env.assertValid()).toThrow(ConfigError);
  expect(() => env.assertValid()).toThrow(
    [
      "Invalid configuration:",
      '  - D: "5 minutes" is not valid; accepted: a duration such as 750ms, 2s, 5m, 12h35m',
      '  - I: "-1" is not valid; accepted: a positive integer',
      '  - B: "yes" is not valid; accepted: true, false',
      '  - E: "z" is not valid; accepted: x, y',
      "  - REQUIRED: required; accepted: any text",
      '  - S_X: "nope" is not valid; accepted: a positive integer',
    ].join("\n"),
  );
});

test("maps ids to their env form", () => {
  expect(envId("tg-main_2")).toBe("TG_MAIN_2");
});
