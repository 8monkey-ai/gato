import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConversationStore } from "./store.ts";

const temporaryRoot = () => mkdtemp(join(tmpdir(), "gato-store-"));

describe("ConversationStore reads", () => {
  test("forgets a damaged chat when a later read finds it repaired", async () => {
    const root = await temporaryRoot();
    const file = join(root, "c/1/chat.txt");
    await Bun.write(file, "[not a header\n");
    const store = await ConversationStore.open(root);
    expect((await store.get("c", "1").read()).damaged).toBe(true);
    expect(store.damagedCount).toBe(1);

    await Bun.write(file, "");
    await store.get("c", "1").read();
    expect(store.damagedCount).toBe(0);
  });

  test("gives no changed chats for a connection that has no folder yet", async () => {
    const store = await ConversationStore.open(await temporaryRoot());
    expect(await store.changedSince("missing", 0)).toEqual([]);
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

  test("rejects unsafe identifiers", async () => {
    const store = await ConversationStore.open(await temporaryRoot());
    expect(() => store.get("c", "../x")).toThrow();
  });
});
