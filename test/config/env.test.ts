import { describe, expect, test } from "bun:test";

import { z } from "zod";

import {
  duration,
  integer,
  json,
  list,
  readEnv,
} from "../../src/config/env.ts";

describe("readEnv", () => {
  test("applies the default when the variable is unset or empty", () => {
    const schema = z.string().default("info");
    expect(readEnv("GATO_X", schema, {})).toBe("info");
    expect(readEnv("GATO_X", schema, { GATO_X: "" })).toBe("info");
  });

  test("names the variable when a required value is missing", () => {
    expect(() => readEnv("GATO_X", z.string(), {})).toThrow(
      new Error("GATO_X: Required"),
    );
  });

  test("names the variable and the JSON path of each problem", () => {
    const connections = json(
      z.record(z.string(), z.object({ botToken: z.string(), port: integer })),
    );
    const env = { GATO_TELEGRAM_CONNECTIONS: '{"main":{"port":"x"}}' };
    expect(() =>
      readEnv("GATO_TELEGRAM_CONNECTIONS", connections, env),
    ).toThrow(
      new Error(
        "GATO_TELEGRAM_CONNECTIONS.main.botToken: Required\nGATO_TELEGRAM_CONNECTIONS.main.port: expected an integer",
      ),
    );
  });

  test("does not show the rejected value, which can be a credential", () => {
    expect(() => readEnv("GATO_X", integer, { GATO_X: "secret-123" })).toThrow(
      new Error("GATO_X: expected an integer"),
    );
  });
});

describe("value schemas", () => {
  test("integer", () => {
    expect(readEnv("V", integer, { V: "-42" })).toBe(-42);
    expect(() => readEnv("V", integer, { V: "4.2" })).toThrow(
      new Error("V: expected an integer"),
    );
  });

  test("integer rejects values outside the safe integer range", () => {
    expect(() => readEnv("V", integer, { V: "9007199254740992" })).toThrow(
      new Error("V: Too big: expected int to be <=9007199254740991"),
    );
  });

  test("duration in milliseconds", () => {
    expect(readEnv("V", duration, { V: "5m" })).toBe(300_000);
    expect(readEnv("V", duration, { V: "12h35m" })).toBe(45_300_000);
    expect(readEnv("V", duration, { V: "1d2h3m4s5ms" })).toBe(93_784_005);
    expect(readEnv("V", duration, { V: "250ms" })).toBe(250);
  });

  test("duration rejects values without units or in the wrong order", () => {
    for (const value of ["300", "5x", "35m12h", "5 m"]) {
      expect(() => readEnv("V", duration, { V: value })).toThrow(
        new Error('V: expected a duration such as "30s", "5m" or "12h35m"'),
      );
    }
  });

  test("list trims entries, drops empty ones and names the bad index", () => {
    expect(readEnv("V", list(z.string()), { V: " a, b ,,c " })).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(() => readEnv("V", list(integer), { V: "1, x" })).toThrow(
      new Error("V[1]: expected an integer"),
    );
  });

  test("json rejects text that is not JSON", () => {
    expect(() => readEnv("V", json(z.object({})), { V: "{main:" })).toThrow(
      new Error("V: expected valid JSON"),
    );
  });
});
