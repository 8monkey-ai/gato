import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConversationStore } from "./store.ts";

const temporaryRoot = () => mkdtemp(join(tmpdir(), "gato-store-"));

describe("ConversationStore", () => {
  test("keeps entries in sent-time order and reloads them", async () => {
    const root = await temporaryRoot();
    const store = await ConversationStore.open(root);
    const chat = store.get("telegram-1", "42");
    await chat.lock(async (edit) => {
      edit.add({
        kind: "message",
        role: "customer",
        at: "2026-01-01T10:00:02.000Z",
        text: "late",
      });
      edit.add({
        kind: "message",
        role: "customer",
        at: "2026-01-01T10:00:01.000Z",
        text: "early",
      });
      await edit.save();
    });
    await chat.saveSummary({ at: "2026-01-01T11:00:00.000Z", text: "Notes" });

    const reopened = (await ConversationStore.open(root)).get(
      "telegram-1",
      "42",
    );
    expect(reopened.entries.map((e) => ("text" in e ? e.text : ""))).toEqual([
      "early",
      "late",
    ]);
    expect(reopened.summary).toEqual({
      at: "2026-01-01T11:00:00.000Z",
      text: "Notes",
    });
    expect(
      await Bun.file(join(root, "telegram-1/42/chat.txt")).text(),
    ).toContain("early");
  });
});

describe("ConversationStore files", () => {
  test("stores attachments inside the chat folder", async () => {
    const chat = (await ConversationStore.open(await temporaryRoot())).get(
      "c",
      "1",
    );
    const file = await chat.writeAttachment(
      new Uint8Array([1, 2]),
      "../../etc/passwd",
    );
    expect(file).toMatch(/^attachments\/[0-9a-f]{8}-passwd$/);
    expect([...(await chat.readAttachment(file))]).toEqual([1, 2]);
    expect(() => chat.readAttachment("../chat.txt")).toThrow();
  });

  test("rejects unsafe identifiers and missing storage", async () => {
    const store = await ConversationStore.open(await temporaryRoot());
    expect(() => store.get("c", "../x")).toThrow();
    await expect(ConversationStore.open("/nonexistent/gato")).rejects.toThrow();
  });
});
