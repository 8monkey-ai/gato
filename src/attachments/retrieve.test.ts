import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createLogger } from "../log.ts";
import { openChatStore } from "../storage/chat-store.ts";
import { retrieveMissing } from "./retrieve.ts";

let dataDir = "";
const log = createLogger({}, () => {});
const ref = { connectionId: "tg", chatId: "42" };

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gato-retrieve-"));
});
afterEach(() => fs.rm(dataDir, { recursive: true, force: true }));

async function storeWithMessage() {
  const store = await openChatStore(dataDir, { timeZone: "UTC", log });
  await store.append(ref, [
    {
      type: "message",
      message: {
        id: "m1",
        author: { role: "customer" },
        sentAt: "2026-11-04T10:15:00.000Z",
        attachments: [
          { id: "a1", category: "image", source: "good" },
          { id: "a2", category: "document", source: "bad", fileName: "x.PDF" },
        ],
        delivery: "observed",
      },
    },
  ]);
  return store;
}

test("saves retrieved files and records failures without removing the message", async () => {
  const store = await storeWithMessage();
  const connection = {
    fetchAttachment: (source: string) =>
      source === "good"
        ? Promise.resolve({
            bytes: new Uint8Array([1, 2]),
            mediaType: "image/jpeg",
          })
        : Promise.reject(new Error("link expired")),
  };
  await retrieveMissing({ store, ref, connection, log });

  const [message] = (await store.load(ref)).messages;
  expect(message?.attachments).toEqual([
    {
      id: "a1",
      category: "image",
      source: "good",
      file: "attachments/m1-a1.jpeg",
      mediaType: "image/jpeg",
    },
    {
      id: "a2",
      category: "document",
      source: "bad",
      fileName: "x.PDF",
      retrievalError: "link expired",
    },
  ]);
  expect([
    ...(await fs.readFile(path.join(dataDir, "tg/42/attachments/m1-a1.jpeg"))),
  ]).toEqual([1, 2]);
});

test("retries only attachments without a file, once per call", async () => {
  const store = await storeWithMessage();
  const sources: string[] = [];
  const connection = {
    fetchAttachment: (source: string) => {
      sources.push(source);
      return source === "good" || sources.length > 2
        ? Promise.resolve({ bytes: new Uint8Array([3]) })
        : Promise.reject(new Error("timeout"));
    },
  };
  await retrieveMissing({ store, ref, connection, log });
  await retrieveMissing({ store, ref, connection, log });

  expect(sources).toEqual(["good", "bad", "bad"]);
  const [message] = (await store.load(ref)).messages;
  expect(message?.attachments.map((a) => a.file)).toEqual([
    "attachments/m1-a1.bin",
    "attachments/m1-a2.pdf",
  ]);
});
