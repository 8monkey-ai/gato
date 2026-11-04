import { afterEach, expect, test } from "bun:test";

import { httpServer, readPort } from "../../src/app/http.ts";
import type { InboundEvent } from "../../src/channel/inbound.ts";
import { createLogger } from "../../src/log/logger.ts";
import { FakeAdapter } from "../support/fake-adapter.ts";

const event: InboundEvent = {
  type: "status",
  chatKey: "42",
  dedupKey: "fake:1",
  at: 1711935000000,
  status: "closed",
};
const logger = createLogger({ GATO_LOG_LEVEL: "silent" });
let server: ReturnType<typeof httpServer> | undefined;

afterEach(async () => {
  await server?.stop();
});

test("serves each adapter route under /<kind>/<connection>", async () => {
  const adapter = new FakeAdapter("fake", "main");
  const received: InboundEvent[] = [];
  await adapter.start({
    accept: (event) => {
      received.push(event);
      return Promise.resolve("saved");
    },
  });
  server = httpServer([adapter], 0, logger);
  server.start();
  const url = new URL("/fake/main", server.url);

  const response = await fetch(url, {
    method: "POST",
    body: JSON.stringify(event),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("saved");
  expect(received).toEqual([event]);
  expect((await fetch(new URL("/fake/other", server.url))).status).toBe(404);
});

test("GATO_PORT is a port number with a default of 3000", () => {
  expect(readPort({})).toBe(3000);
  expect(readPort({ GATO_PORT: "8080" })).toBe(8080);
  expect(() => readPort({ GATO_PORT: "70000" })).toThrow(
    new Error("GATO_PORT: Too big: expected number to be <=65535"),
  );
});
