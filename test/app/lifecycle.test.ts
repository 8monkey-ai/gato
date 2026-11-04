import { expect, spyOn, test } from "bun:test";

import {
  readShutdownTimeout,
  run,
  type Startable,
  startAll,
  stopWithin,
} from "../../src/app/lifecycle.ts";
import { createLogger } from "../../src/log/logger.ts";

const logger = createLogger({ GATO_LOG_LEVEL: "silent" });

function part(name: string, calls: string[], failStart = false): Startable {
  return {
    start: () => {
      calls.push(`start ${name}`);
      return failStart
        ? Promise.reject(new Error(`${name} failed`))
        : Promise.resolve();
    },
    stop: () => {
      calls.push(`stop ${name}`);
      return Promise.resolve();
    },
  };
}

test("stops the parts in the reverse order of their start", async () => {
  const calls: string[] = [];
  const stop = await startAll(
    [part("http", calls), part("a", calls), part("b", calls)],
    logger,
  );
  await stop();
  expect(calls).toEqual([
    "start http",
    "start a",
    "start b",
    "stop b",
    "stop a",
    "stop http",
  ]);
});

test("a failed start stops the parts that started and throws", async () => {
  const calls: string[] = [];
  const parts = [part("http", calls), part("a", calls, true), part("b", calls)];
  await expect(startAll(parts, logger)).rejects.toThrow(new Error("a failed"));
  expect(calls).toEqual(["start http", "start a", "stop http"]);
});

test("a part that fails to stop does not prevent the others from stopping", async () => {
  const calls: string[] = [];
  const failing = {
    start: () => Promise.resolve(),
    stop: () => Promise.reject(new Error("stuck")),
  };
  const stop = await startAll([part("http", calls), failing], logger);
  await stop();
  expect(calls).toEqual(["start http", "stop http"]);
});

test("the shutdown bound ends the wait for a stop that does not finish", async () => {
  expect(await stopWithin(() => new Promise(() => {}), 10)).toBe(false);
  expect(await stopWithin(() => Promise.resolve(), 10)).toBe(true);
});

test("a second signal during shutdown does not stop the parts again", async () => {
  const calls: string[] = [];
  const codes: unknown[] = [];
  const exited = Promise.withResolvers<void>();
  const exit = spyOn(process, "exit").mockImplementation((code) => {
    codes.push(code);
    exited.resolve();
    return undefined as never;
  });
  try {
    await run([part("http", calls)], { logger, shutdownTimeoutMs: 1000 });
    process.emit("SIGTERM", "SIGTERM");
    process.emit("SIGINT", "SIGINT");
    await exited.promise;
    await Bun.sleep(10);
  } finally {
    exit.mockRestore();
  }
  expect(calls).toEqual(["start http", "stop http"]);
  expect(codes).toEqual([0]);
});

test("GATO_SHUTDOWN_TIMEOUT is a duration with a default of 30s", () => {
  expect(readShutdownTimeout({})).toBe(30000);
  expect(readShutdownTimeout({ GATO_SHUTDOWN_TIMEOUT: "5s" })).toBe(5000);
  expect(() => readShutdownTimeout({ GATO_SHUTDOWN_TIMEOUT: "5" })).toThrow(
    new Error(
      'GATO_SHUTDOWN_TIMEOUT: expected a duration such as "30s", "5m" or "12h35m"',
    ),
  );
});
