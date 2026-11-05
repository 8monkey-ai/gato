import { expect, test } from "bun:test";

import { waitFor } from "./support/app.ts";
import { useHarness } from "./support/fixture.ts";
import { conversation } from "./support/gateway.ts";
import { deliver, incoming } from "./support/respondio.ts";

const f = useHarness(["tg", "rio"]);

test("§8 respond.io and Telegram work at the same time with isolated histories and routing for matching identifiers", async () => {
  f.gateway.reply((request) => ({
    text: `Echo ${conversation(request).at(-1)?.[1]}`,
  }));
  const app = await f.start();
  f.telegram.customerMessage(5, { text: "From Telegram" });
  await waitFor(() => f.telegram.sentTexts(5).length === 1);
  await deliver(
    app.url,
    incoming("5", { type: "text", text: "From respond.io" }),
  );
  await waitFor(() => f.respond.sentTexts("5").length === 1);
  expect(f.telegram.sentTexts(5)).toEqual(["Echo From Telegram"]);
  expect(f.respond.sentTexts("5")).toEqual(["Echo From respond.io"]);
  expect(conversation(f.gateway.requests[1]!)).toEqual([
    ["user", "From respond.io"],
  ]);
});

test("§8 a disabled connection needs no credentials or service", async () => {
  f.gateway.reply({ text: "Telegram only" });
  await f.start({
    CONNECTIONS: "tg",
    CONNECTION_RIO_TYPE: "",
    CONNECTION_RIO_API_TOKEN: "",
    CONNECTION_RIO_WEBHOOK_SIGNING_KEYS: "",
    CONNECTION_RIO_AGENT_USER_ID: "",
  });
  f.telegram.customerMessage(6, { text: "Hi" });
  await waitFor(() => f.telegram.sentTexts(6).length === 1);
});
