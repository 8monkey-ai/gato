import { expect, test } from "bun:test";

import { createLogger } from "./log.ts";

test("writes JSON lines and redacts sensitive keys at any depth", () => {
  const lines: string[] = [];
  const log = createLogger({ service: "gato", apiKey: "k" }, (line) =>
    lines.push(line),
  );
  log
    .child({ chatId: "c1" })
    .warn("message.received", { text: "hi", meta: { Phone: "+63", size: 2 } });
  const { time, ...rest } = JSON.parse(lines[0] ?? "{}") as Record<
    string,
    unknown
  >;
  expect(typeof time).toBe("string");
  expect(rest).toEqual({
    level: "warn",
    event: "message.received",
    service: "gato",
    apiKey: "[redacted]",
    chatId: "c1",
    text: "[redacted]",
    meta: { Phone: "[redacted]", size: 2 },
  });
});
