import { expect, test } from "bun:test";
import { join } from "node:path";

import { logEvents, tempDir, waitFor } from "./support/app.ts";
import { useTelegram } from "./support/fixture.ts";
import {
  conversation,
  mainRequests,
  preparationRequests,
  systemText,
} from "./support/gateway.ts";
import {
  ago,
  ask,
  day,
  history,
  prepareChat,
  replyWithSummary,
  summaryFile,
} from "./support/history.ts";
import { readChat } from "./support/setup.ts";

const f = useTelegram();

test("§4 a summary less than three days old is reused as private context before the conversation", async () => {
  const dataDir = await prepareChat(history(10 * day), {
    date: ago(day),
    text: "Saved notes",
  });
  f.gateway.reply(replyWithSummary());
  await ask(f, dataDir);
  expect(preparationRequests(f.gateway)).toHaveLength(0);
  const first = conversation(mainRequests(f.gateway)[0]!)[0]!;
  expect(first[0]).toBe("assistant");
  expect(first[1]).toStartWith(
    "[Private summary of earlier conversations with this customer, written ",
  );
  expect(first[1]).toEndWith("]\nSaved notes");
});

test("§4 without a summary, one is generated once the oldest recent message is three days old, and saved with its date", async () => {
  const dataDir = await prepareChat(history(4 * day));
  f.gateway.reply(replyWithSummary());
  await ask(f, dataDir);
  expect(
    preparationRequests(f.gateway).map((request) => request.model),
  ).toEqual(["test/base"]);
  const saved = await summaryFile(dataDir).text();
  expect(saved).toMatch(
    /^Date: \d{4}-\d\d-\d\dT.+\n\nPrimary Language used in this conversation: English\n- wants a new card$/,
  );
  expect(conversation(mainRequests(f.gateway)[0]!)[0]![1]).toContain(
    "- wants a new card",
  );
});

test("§4 without a summary and with only recent messages, no summary is generated", async () => {
  const dataDir = await prepareChat(history(2 * day));
  f.gateway.reply(replyWithSummary());
  await ask(f, dataDir);
  expect(preparationRequests(f.gateway)).toHaveLength(0);
  expect(await summaryFile(dataDir).exists()).toBe(false);
});

test("§4 a summary three days old is refreshed from the latest calendar month only, with a dedicated summary model", async () => {
  const old = {
    kind: "message",
    id: "o1",
    at: ago(40 * day),
    role: "customer",
    ref: "0",
    text: "Ancient question",
  };
  const dataDir = await prepareChat([old, ...history(5 * day)], {
    date: ago(3 * day + 60_000),
    text: "Old notes",
  });
  f.gateway.reply(replyWithSummary("Fresh notes"));
  await ask(f, dataDir, {
    SUMMARY_MODEL: "test/summary",
    TIMEZONE: "Asia/Manila",
  });
  const summary = preparationRequests(f.gateway)[0]!;
  expect(summary.model).toBe("test/summary");
  expect(mainRequests(f.gateway)[0]!.model).toBe("test/base");
  const input = conversation(summary)
    .map(([, text]) => text)
    .join("\n");
  expect(input).toMatch(
    /^\[\d{4}-\d\d-\d\d \d\d:\d\d\] Customer: I need a new card\n\[.+\] Agent: Sure\n\[.+\] Customer: Any update\?$/,
  );
  expect(input).not.toContain("Ancient");
  expect(await summaryFile(dataDir).text()).toEndWith("\n\nFresh notes");
});

test("§4 the repository summary prompt is the default and starts with the primary-language line", async () => {
  const dataDir = await prepareChat(history(4 * day));
  f.gateway.reply(replyWithSummary());
  await ask(f, dataDir);
  expect(systemText(preparationRequests(f.gateway)[0]!)).toStartWith(
    "Primary Language used in this conversation:",
  );
});

test("§4 a configured prompt replaces the default for the next generation without forcing a refresh", async () => {
  const prompt = join(await tempDir(), "prompt.md");
  await Bun.write(prompt, "Custom summary prompt");
  const fresh = await prepareChat(history(10 * day), {
    date: ago(day),
    text: "Kept",
  });
  f.gateway.reply(replyWithSummary());
  await ask(f, fresh, { SUMMARY_PROMPT_FILE: prompt });
  expect(preparationRequests(f.gateway)).toHaveLength(0);
  await f.app.stop();
  const due = await prepareChat(history(10 * day));
  f.gateway.requests.length = 0;
  await ask(f, due, { SUMMARY_PROMPT_FILE: prompt });
  const summary = await waitFor(() => preparationRequests(f.gateway)[0]);
  expect(systemText(summary)).toBe("Custom summary prompt");
});

test("§4 empty summary output keeps the previous summary", async () => {
  const dataDir = await prepareChat(history(10 * day), {
    date: ago(5 * day),
    text: "Previous notes",
  });
  f.gateway.reply(replyWithSummary("   "));
  await ask(f, dataDir);
  expect(await summaryFile(dataDir).text()).toEndWith("\n\nPrevious notes");
  expect(conversation(mainRequests(f.gateway)[0]!)[0]![1]).toEndWith(
    "Previous notes",
  );
});

test("§4 a failed summary is logged, the reply proceeds without summary context, and the saved summary stays", async () => {
  const dataDir = await prepareChat(history(10 * day), {
    date: ago(5 * day),
    text: "Previous notes",
  });
  f.gateway.reply((request) =>
    request.stream ? { text: "Hello again" } : { status: 500 },
  );
  await ask(f, dataDir);
  expect(f.telegram.sentTexts(1)).toEqual(["Hello again"]);
  expect(logEvents(f.app.logs, "summary.failed")).toHaveLength(1);
  expect(conversation(mainRequests(f.gateway)[0]!)[0]).toEqual([
    "user",
    "I need a new card",
  ]);
  expect(await summaryFile(dataDir).text()).toEndWith("\n\nPrevious notes");
});

test("§6 summary generation counts toward the turn's work limit", async () => {
  const dataDir = await prepareChat(history(4 * day));
  f.gateway.reply(replyWithSummary());
  await ask(f, dataDir, { TURN_MAX_STEPS: "1" });
  await waitFor(async () =>
    (await readChat(dataDir, "tg", "1")).some(
      (entry) => entry.type === "outcome",
    ),
  );
  expect(preparationRequests(f.gateway)).toHaveLength(1);
  expect(mainRequests(f.gateway)).toHaveLength(0);
});
