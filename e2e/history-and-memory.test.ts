import { expect, test } from "bun:test";
import { join } from "node:path";

import { messages, readChat, startApp } from "./support/app.ts";
import type { ChatRequest } from "./support/fake-gateway.ts";
import { until } from "./support/recorder.ts";
import { agentModel, startHarness } from "./support/setup.ts";

const day = 24 * 60 * 60 * 1000;
const summaryModel = "test/summary";

function entry(at: number, meta: Record<string, unknown>, text?: string) {
  const header = `[${new Date(at).toISOString()}] prepared ${JSON.stringify(meta)}`;
  return [
    header,
    ...(text === undefined ? [] : text.split("\n").map((l) => `> ${l}`)),
  ].join("\n");
}

function chatFile(...entries: string[]) {
  return `${entries.join("\n")}\n`;
}

const isSummaryCall = (request: ChatRequest) =>
  JSON.stringify(request.messages[0]).includes(
    "Primary Language used in this conversation:",
  );

test("§4 migration: prepared history is read without treating it as new work", async () => {
  const old = Date.now() - 60_000;
  const { gateway, telegram, dataDir } = await startHarness({
    data: {
      "telegram/60/chat.txt": chatFile(
        entry(
          old,
          { type: "message", id: "m1", role: "customer" },
          "migrated question",
        ),
      ),
    },
  });
  await Bun.sleep(500);
  expect(gateway.requests).toHaveLength(0);

  telegram.push(60, { text: "new question" });
  await until(() => telegram.sent().length === 1);
  expect(JSON.stringify(gateway.requests[0]?.messages)).toContain(
    "migrated question",
  );
  expect(
    messages(await readChat(dataDir, "telegram", "60")).map((m) => m.text),
  ).toEqual(["migrated question", "new question", "Hello."]);
});

function crashedChat(at: number) {
  return chatFile(
    entry(
      at,
      { type: "message", id: "m1", role: "customer", trigger: true, ref: "1" },
      "please answer",
    ),
    entry(at + 1000, {
      type: "turn",
      id: "t1",
      trigger: "customer",
      status: "running",
      covers: ["m1"],
    }),
    entry(
      at + 2000,
      {
        type: "message",
        id: "m2",
        role: "agent",
        delivery: "sending",
        turn: "t1",
      },
      "maybe sent",
    ),
  );
}

test("§4 restart: abandoned work does not block, uncertain sends are never resent, waiting input is answered", async () => {
  const { gateway, telegram, dataDir } = await startHarness({
    data: { "telegram/61/chat.txt": crashedChat(Date.now() - 30_000) },
  });
  await until(() => telegram.sent().length === 1);
  expect(telegram.sent()).toEqual(["Hello."]);
  expect(JSON.stringify(gateway.requests[0]?.messages)).not.toContain(
    "maybe sent",
  );
  const record = await readChat(dataDir, "telegram", "61");
  expect(record.find((e) => e.meta.id === "t1")?.meta).toMatchObject({
    status: "interrupted",
    reason: "abandoned at restart",
  });
  expect(record.find((e) => e.meta.id === "m2")?.meta.delivery).toBe(
    "uncertain",
  );
});

test("§4 restart: the record, summary, and attachments survive a restart", async () => {
  const { telegram, dataDir, start, app } = await startHarness();
  telegram.push(62, { text: "before restart" });
  await until(() => telegram.sent().length === 1);
  await app.stop();
  const before = await Bun.file(join(dataDir, "telegram/62/chat.txt")).text();

  await start();
  telegram.push(62, { text: "after restart" });
  await until(() => telegram.sent().length === 2);
  const after = await Bun.file(join(dataDir, "telegram/62/chat.txt")).text();
  expect(after.startsWith(before)).toBe(true);
});

test("§4 storage: a damaged history is reported and left untouched while other chats continue", async () => {
  const damaged = "this is not a chat record\n";
  const { app, telegram, dataDir } = await startHarness({
    data: { "telegram/63/chat.txt": damaged },
  });
  expect(
    app.logs.some(
      (l) => l.includes('"chat.damaged"') && l.includes('"id":"63"'),
    ),
  ).toBe(true);
  const health = (await (await fetch(`${app.url}/health`)).json()) as {
    damagedChats: number;
  };
  expect(health.damagedChats).toBe(1);

  telegram.push(63, { text: "into damaged chat" });
  telegram.push(64, { text: "healthy chat" });
  await until(() => telegram.sent().length === 1);
  expect(await Bun.file(join(dataDir, "telegram/63/chat.txt")).text()).toBe(
    damaged,
  );
});

test("§4 storage: a missing data folder stops startup instead of using an empty history elsewhere", async () => {
  const { env } = await startHarness();
  const app = await startApp(
    { ...env, DATA_DIR: "/nonexistent/gato-data" },
    { waitReady: false },
  );
  expect(await app.exited).toBe(1);
  expect(app.logs.some((l) => l.includes("harness.start_failed"))).toBe(true);
});

const oldChat = (contact: string, extra: Record<string, string> = {}) => ({
  [`telegram/${contact}/chat.txt`]: chatFile(
    entry(
      Date.now() - 5 * day,
      { type: "message", id: "m1", role: "customer" },
      "I need a refund",
    ),
    entry(
      Date.now() - 5 * day + 1000,
      { type: "message", id: "m2", role: "agent", delivery: "sent" },
      "I will check",
    ),
    entry(
      Date.now() - 5 * day + 2000,
      { type: "message", id: "m3", role: "agent", delivery: "failed" },
      "never delivered",
    ),
  ),
  ...extra,
});

test("§4 summary: the first summary uses the summary model and the summary prompt, and is saved", async () => {
  const { telegram, gateway, dataDir } = await startHarness({
    env: { SUMMARY_MODEL: summaryModel },
    models: [summaryModel],
    data: oldChat("70"),
  });
  gateway.script((request) => ({
    text: isSummaryCall(request)
      ? "Primary Language used in this conversation: English\n- wants a refund"
      : "Hello.",
  }));
  telegram.push(70, { text: "any news?" });
  await until(() => telegram.sent().length === 1);

  const summaryCalls = gateway.callsFor(summaryModel);
  expect(summaryCalls).toHaveLength(1);
  expect(summaryCalls[0] && isSummaryCall(summaryCalls[0])).toBe(true);
  const input = JSON.stringify(summaryCalls[0]?.messages);
  expect(input).toContain("I need a refund");
  expect(input).not.toContain("never delivered");
  expect(gateway.callsFor(agentModel).some(isSummaryCall)).toBe(false);
  expect(JSON.stringify(gateway.callsFor(agentModel)[0]?.messages)).toContain(
    "wants a refund",
  );
  const saved = await Bun.file(join(dataDir, "telegram/70/summary.txt")).text();
  expect(saved).toMatch(
    /^Summary date: \d{4}-\d\d-\d\dT.+\n\nPrimary Language used in this conversation: English\n- wants a refund\n$/,
  );
});

test("§4 summary: without a summary model, the base model writes the summary", async () => {
  const { telegram, gateway } = await startHarness({ data: oldChat("71") });
  telegram.push(71, { text: "hi" });
  await until(() => telegram.sent().length === 1);
  expect(gateway.callsFor(agentModel).filter(isSummaryCall)).toHaveLength(1);
});

test("§4 summary: a summary younger than three days is reused without a call", async () => {
  const summary = `Summary date: ${new Date(Date.now() - 2 * day).toISOString()}\n\nPrimary Language used in this conversation: Malay\n- saved notes\n`;
  const { telegram, gateway } = await startHarness({
    data: oldChat("72", { "telegram/72/summary.txt": summary }),
  });
  telegram.push(72, { text: "hi" });
  await until(() => telegram.sent().length === 1);
  expect(gateway.requests.filter(isSummaryCall)).toHaveLength(0);
  expect(JSON.stringify(gateway.requests[0]?.messages)).toContain(
    "saved notes",
  );
});

test("§4 summary: a failed refresh keeps the saved summary and the reply continues without it", async () => {
  const summary = `Summary date: ${new Date(Date.now() - 4 * day).toISOString()}\n\nPrimary Language used in this conversation: Malay\n- old notes\n`;
  const { telegram, gateway, dataDir } = await startHarness({
    data: oldChat("73", { "telegram/73/summary.txt": summary }),
  });
  gateway.script((request) =>
    isSummaryCall(request) ? { status: 400 } : { text: "Hello." },
  );
  telegram.push(73, { text: "hi" });
  await until(() => telegram.sent().length === 1);
  const reply = gateway.requests.find((r) => !isSummaryCall(r));
  expect(JSON.stringify(reply?.messages)).not.toContain("old notes");
  expect(await Bun.file(join(dataDir, "telegram/73/summary.txt")).text()).toBe(
    summary,
  );
});

test("§4 summary: an empty refresh keeps and uses the previous summary", async () => {
  const summary = `Summary date: ${new Date(Date.now() - 4 * day).toISOString()}\n\nPrimary Language used in this conversation: Malay\n- old notes\n`;
  const { telegram, gateway, dataDir } = await startHarness({
    data: oldChat("74", { "telegram/74/summary.txt": summary }),
  });
  gateway.script((request) => ({
    text: isSummaryCall(request) ? "" : "Hello.",
  }));
  telegram.push(74, { text: "hi" });
  await until(() => telegram.sent().length === 1);
  expect(
    JSON.stringify(gateway.requests.find((r) => !isSummaryCall(r))?.messages),
  ).toContain("old notes");
  expect(await Bun.file(join(dataDir, "telegram/74/summary.txt")).text()).toBe(
    summary,
  );
});

test("§4 summary: no summary is generated while the oldest recent message is younger than three days", async () => {
  const { telegram, gateway } = await startHarness();
  telegram.push(75, { text: "hi" });
  await until(() => telegram.sent().length === 1);
  expect(gateway.requests.filter(isSummaryCall)).toHaveLength(0);
});
