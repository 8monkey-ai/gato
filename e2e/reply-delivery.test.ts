import { expect, test } from "bun:test";

import { messages, readChat } from "./support/app.ts";
import { until } from "./support/recorder.ts";
import { startHarness } from "./support/setup.ts";

test("§6 delivery: each paragraph is one message, in order, sent once", async () => {
  const { telegram, gateway, dataDir } = await startHarness();
  gateway.script(() => ({
    text: "Hello Ali!\n\nOur price is RM 10.\n\n\n\nAnything else?",
  }));
  telegram.push(42, { text: "How much?" });

  await until(() => telegram.sent().length === 3);
  expect(telegram.sent()).toEqual([
    "Hello Ali!",
    "Our price is RM 10.",
    "Anything else?",
  ]);

  const record = messages(await readChat(dataDir, "telegram", "42"));
  expect(
    record.map((m) => [m.meta.role, m.text, m.meta.delivery ?? null]),
  ).toEqual([
    ["customer", "How much?", null],
    ["agent", "Hello Ali!", "sent"],
    ["agent", "Our price is RM 10.", "sent"],
    ["agent", "Anything else?", "sent"],
  ]);
});
