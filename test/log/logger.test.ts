import { expect, test } from "bun:test";

import { createLogger } from "../../src/log/logger.ts";

function capture(env: Record<string, string> = {}) {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(env, {
    write: (line: string) =>
      lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

test("redacts credential and personal keys at any depth", () => {
  const { logger, lines } = capture();
  logger.info(
    {
      botToken: "123:abc",
      connection: {
        apiKey: "k",
        headers: { Authorization: "Bearer x" },
        name: "main",
        webhookSigningKeys: ["a", "b"],
      },
      parts: [{ text: "hello", caption: "c", kind: "text" }],
      contact: { phone: "0123", email: "a@b.c" },
      password: "p",
      webhookSecret: "s",
      usage: { inputTokens: 10, maxTokens: 100 },
    },
    "inbound",
  );
  expect(lines[0]).toMatchObject({
    botToken: "[redacted]",
    connection: {
      apiKey: "[redacted]",
      headers: { Authorization: "[redacted]" },
      name: "main",
      webhookSigningKeys: "[redacted]",
    },
    parts: [{ text: "[redacted]", caption: "[redacted]", kind: "text" }],
    contact: { phone: "[redacted]", email: "[redacted]" },
    password: "[redacted]",
    webhookSecret: "[redacted]",
    usage: { inputTokens: 10, maxTokens: 100 },
    msg: "inbound",
  });
});

test("redacts fields of Errors, logged directly or inside objects", () => {
  const { logger, lines } = capture();
  const error = Object.assign(new Error("request failed"), {
    config: { headers: { Authorization: "Bearer x" } },
  });
  logger.error(error);
  logger.error({ attempt: { error } }, "retrying");
  const redacted = {
    type: "Error",
    message: "request failed",
    config: { headers: { Authorization: "[redacted]" } },
  };
  expect(lines[0]).toMatchObject({ err: redacted });
  expect(lines[1]).toMatchObject({ attempt: { error: redacted } });
});

test("replaces circular references and keeps shared ones", () => {
  const { logger, lines } = capture();
  const loop: Record<string, unknown> = { name: "loop" };
  loop.self = loop;
  const shared = { id: 1 };
  logger.info({ loop, first: shared, second: shared });
  expect(lines[0]).toMatchObject({
    loop: { name: "loop", self: "[Circular]" },
    first: { id: 1 },
    second: { id: 1 },
  });
});

test("level comes from GATO_LOG_LEVEL with info as default", () => {
  expect(capture().logger.level).toBe("info");
  expect(capture({ GATO_LOG_LEVEL: "warn" }).logger.level).toBe("warn");
});

test("rejects an unknown level and names the variable", () => {
  expect(() => capture({ GATO_LOG_LEVEL: "loud" })).toThrow(
    new Error(
      'GATO_LOG_LEVEL: Invalid option: expected one of "fatal"|"error"|"warn"|"info"|"debug"|"trace"|"silent"',
    ),
  );
});
