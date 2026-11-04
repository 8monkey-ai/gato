import { afterEach, expect, test } from "bun:test";

import { createAdapters } from "../../src/app/channels.ts";
import { httpServer } from "../../src/app/http.ts";
import { inboundService } from "../../src/conversation/service.ts";
import { createLogger } from "../../src/log/logger.ts";
import { tmpDataDir } from "../support/data-dir.ts";
import { fakeRegistration } from "../support/fake-adapter.ts";
import { chatFile, openTestStore } from "../support/store.ts";

const logger = createLogger({ GATO_LOG_LEVEL: "silent" });
let server: ReturnType<typeof httpServer> | undefined;

afterEach(async () => {
  await server?.stop();
});

test("a repeated notification over HTTP is saved once in the chat folder", async () => {
  const dataDir = await tmpDataDir();
  const [adapter] = createAdapters(
    [fakeRegistration("fake", "GATO_FAKE_CONNECTIONS")],
    { GATO_FAKE_CONNECTIONS: '{"main":{"token":"t"}}' },
    logger,
  );
  const inbound = inboundService({
    store: await openTestStore(dataDir),
    logger,
  });
  await adapter!.start(inbound.sinkFor(adapter!));
  server = httpServer([adapter!], 0, logger);
  server.start();

  const post = async () => {
    const response = await fetch(new URL("/fake/main", server!.url), {
      method: "POST",
      body: JSON.stringify({
        type: "message",
        chatKey: "42",
        dedupKey: "fake:1",
        at: 1711935000000,
        role: "customer",
        sender: { known: true },
        parts: [{ kind: "text", text: "Hello" }],
      }),
    });
    return response.text();
  };
  expect(await post()).toBe("saved");
  expect(await post()).toBe("duplicate");

  const lines = await chatFile(dataDir, "events.jsonl");
  expect(
    lines
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line)),
  ).toMatchObject([
    { seq: 1, type: "message", dedupKey: "fake:1", role: "customer" },
  ]);
});
