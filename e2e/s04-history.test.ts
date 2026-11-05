import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { logEvents, tempDir, waitFor } from "./support/app.ts";
import { useTelegram } from "./support/fixture.ts";
import { conversation } from "./support/gateway.ts";
import { readChat, writeChat } from "./support/setup.ts";

const f = useTelegram();

test("§4 restart preserves the complete record and the next turn uses it", async () => {
  f.gateway.reply({ text: "First reply" });
  await f.start();
  f.telegram.customerMessage(1, { text: "Before restart" });
  await waitFor(() => f.telegram.sentTexts(1).length === 1);
  await f.restart();
  f.gateway.reply({ text: "Second reply" });
  f.telegram.customerMessage(1, { text: "After restart" });
  await waitFor(() => f.telegram.sentTexts(1).length === 2);
  expect(conversation(f.gateway.requests[1]!)).toEqual([
    ["user", "Before restart"],
    ["assistant", "First reply"],
    ["user", "After restart"],
  ]);
});

test("§4 a delayed message keeps its original place in chronology", async () => {
  f.gateway.reply({ text: "Ok" });
  await f.start();
  f.telegram.customerMessage(1, { text: "Recent" });
  await waitFor(() => f.telegram.sentTexts(1).length === 1);
  const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
  f.telegram.customerMessage(1, { text: "Delayed", date: oneHourAgo });
  await waitFor(() => f.telegram.sentTexts(1).length === 2);
  const customer = (await readChat(f.app.dataDir, "tg", "1")).filter(
    (entry) => entry.role === "customer",
  );
  expect(customer.map((entry) => entry.text)).toEqual(["Delayed", "Recent"]);
});

test("§4 externally prepared chat folders are read without being treated as new requests", async () => {
  const dataDir = await tempDir();
  const at = new Date(Date.now() - 60_000).toISOString();
  await writeChat(dataDir, "tg", "3", [
    {
      kind: "message",
      id: "m1",
      at,
      role: "customer",
      ref: "1",
      text: "Migrated question",
    },
  ]);
  f.gateway.reply({ text: "New reply" });
  await f.start({ DATA_DIR: dataDir });
  await Bun.sleep(500);
  expect(f.gateway.requests).toHaveLength(0);
  f.telegram.customerMessage(3, { text: "New question" });
  await waitFor(() => f.telegram.sentTexts(3).length === 1);
  expect(conversation(f.gateway.requests[0]!)).toEqual([
    ["user", "Migrated question"],
    ["user", "New question"],
  ]);
});

test("§4 damaged histories are reported while other conversations continue", async () => {
  const dataDir = await tempDir();
  await mkdir(join(dataDir, "tg", "4"), { recursive: true });
  await Bun.write(join(dataDir, "tg", "4", "chat.txt"), "{not json\n");
  f.gateway.reply({ text: "Fine" });
  const app = await f.start({ DATA_DIR: dataDir });
  const health = (await (await fetch(`${app.url}/health`)).json()) as {
    damagedHistories: number;
  };
  expect(health.damagedHistories).toBe(1);
  expect(
    logEvents(app.logs, "history.damaged").map((item) => item.chat),
  ).toEqual(["4"]);
  f.telegram.customerMessage(4, { text: "Lost?" });
  f.telegram.customerMessage(5, { text: "Other" });
  await waitFor(() => f.telegram.sentTexts(5).length === 1);
  expect(await Bun.file(join(dataDir, "tg", "4", "chat.txt")).text()).toBe(
    "{not json\n",
  );
  expect(f.telegram.sentTexts(4)).toHaveLength(0);
});

test("§4 an interrupted send found after restart is marked uncertain and never resent", async () => {
  const dataDir = await tempDir();
  const at = new Date(Date.now() - 60_000).toISOString();
  await writeChat(
    dataDir,
    "tg",
    "6",
    [
      {
        kind: "message",
        id: "c1",
        at,
        role: "customer",
        ref: "1",
        text: "Question",
      },
      {
        kind: "message",
        id: "a1",
        at,
        role: "agent",
        text: "Half sent",
        delivery: "sending",
        turn: "t1",
      },
    ],
    {
      assignee: "agent",
      open: true,
      labels: [],
      profile: {},
      pendingReply: false,
      activeTurn: "t1",
    },
  );
  await f.start({ DATA_DIR: dataDir });
  const entries = await waitFor(async () => {
    const chat = await readChat(dataDir, "tg", "6");
    return chat.some((entry) => entry.type === "outcome") && chat;
  });
  expect(entries.find((entry) => entry.id === "a1")?.delivery).toBe(
    "uncertain",
  );
  expect(entries.find((entry) => entry.type === "outcome")?.text).toBe(
    "Turn interrupted: the harness restarted.",
  );
  await Bun.sleep(300);
  expect(f.telegram.sentTexts(6)).toHaveLength(0);
});
