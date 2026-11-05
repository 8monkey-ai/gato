import { expect, test } from "bun:test";

import { waitFor } from "./support/app.ts";
import { useTelegram } from "./support/fixture.ts";
import { messageText } from "./support/gateway.ts";
import { readChat } from "./support/setup.ts";

const f = useTelegram();

test("§1 Telegram: a customer message gets a reply and both are recorded with attribution", async () => {
  f.gateway.reply({ text: "Hi Ana, how can I help?" });
  await f.start();
  f.telegram.customerMessage(7, { text: "Hello there" });

  await waitFor(() => f.telegram.sentTexts(7).length === 1, 8000, "reply");
  expect(f.telegram.sentTexts(7)).toEqual(["Hi Ana, how can I help?"]);
  const lastUser = f.gateway.requests[0]!.messages.at(-1)!;
  expect(lastUser.role).toBe("user");
  expect(messageText(lastUser)).toBe("Hello there");

  const chat = await waitFor(async () => {
    const entries = await readChat(f.app.dataDir, "tg", "7");
    return (
      entries.some(
        (entry) => entry.role === "agent" && entry.delivery === "sent",
      ) && entries
    );
  });
  const messages = chat.filter((entry) => entry.kind === "message");
  expect(
    messages.map((entry) => [entry.role, entry.text, entry.delivery]),
  ).toEqual([
    ["customer", "Hello there", undefined],
    ["agent", "Hi Ana, how can I help?", "sent"],
  ]);
});

test("§1 repeated notifications do not duplicate messages or replies", async () => {
  f.gateway.reply({ text: "Hello" });
  await f.start();
  const update = f.telegram.customerMessage(8, { text: "Hi" });
  await waitFor(() => f.telegram.sentTexts(8).length === 1);
  f.telegram.repeat(update);
  await Bun.sleep(600);
  const entries = await readChat(f.app.dataDir, "tg", "8");
  expect(entries.filter((entry) => entry.role === "customer")).toHaveLength(1);
  expect(f.telegram.sentTexts(8)).toHaveLength(1);
  expect(f.gateway.requests).toHaveLength(1);
});

test("§1 outgoing agent messages do not trigger another answer", async () => {
  f.gateway.reply({ text: "One answer" });
  await f.start();
  f.telegram.customerMessage(9, { text: "Question" });
  await waitFor(() => f.telegram.sentTexts(9).length === 1);
  await Bun.sleep(600);
  expect(f.gateway.requests).toHaveLength(1);
});
