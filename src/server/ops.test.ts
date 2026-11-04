import { expect, test } from "bun:test";

import { opsRoutes } from "./ops.ts";

const calls: unknown[][] = [];
const routes = opsRoutes({
  token: "secret",
  failedNudges: (since) => {
    calls.push(["failed", since.toISOString()]);
    return Promise.resolve([]);
  },
  retryFailedNudges: (since) => {
    calls.push(["retry", since.toISOString()]);
    return Promise.resolve([]);
  },
  merge: (connectionId, fromChatId, intoChatId) => {
    calls.push(["merge", connectionId, fromChatId, intoChatId]);
    return fromChatId === "gone"
      ? Promise.reject(new Error("Unknown chat: gone"))
      : Promise.resolve();
  },
  inspect: () => Promise.resolve([{ chatId: "42" }]),
});

const call = async (
  path: string,
  init: RequestInit & { query?: string; auth?: string } = {},
) => {
  const handler = routes[path];
  if (!handler) throw new Error(`no route ${path}`);
  const response = await handler(
    new Request(`http://x${path}${init.query ?? ""}`, {
      ...init,
      headers: { authorization: init.auth ?? "Bearer secret" },
    }),
  );
  return [response.status, await response.json()] as const;
};

test("a missing or wrong token gets 401", async () => {
  expect(await call("/ops/chats", { auth: "" })).toEqual([
    401,
    { error: "unauthorized" },
  ]);
  expect((await call("/ops/chats", { auth: "Bearer secreT" }))[0]).toBe(401);
  expect(await call("/ops/chats")).toEqual([200, [{ chatId: "42" }]]);
});

test("bad input gets 400 and valid input reaches the operation", async () => {
  calls.length = 0;
  expect(
    (await call("/ops/nudges/failed", { query: "?since=yesterday" }))[0],
  ).toBe(400);
  expect(
    (await call("/ops/nudges/retry", { method: "POST", body: "{" }))[0],
  ).toBe(400);
  expect(
    (
      await call("/ops/merge", {
        method: "POST",
        body: JSON.stringify({ connectionId: "rio" }),
      })
    )[0],
  ).toBe(400);
  expect((await call("/ops/nudges/retry", { method: "GET" }))[0]).toBe(405);
  expect(
    await call("/ops/nudges/failed", { query: "?since=2026-11-04T10:00:00Z" }),
  ).toEqual([200, []]);
  const since = JSON.stringify({ since: "2026-11-04T10:00:00Z" });
  expect(
    await call("/ops/nudges/retry", { method: "POST", body: since }),
  ).toEqual([200, []]);
  const merge = (fromChatId: string) =>
    call("/ops/merge", {
      method: "POST",
      body: JSON.stringify({
        connectionId: "rio",
        fromChatId,
        intoChatId: "new",
      }),
    });
  expect(await merge("old")).toEqual([200, { merged: true }]);
  expect(await merge("gone")).toEqual([400, { error: "Unknown chat: gone" }]);
  expect(calls).toEqual([
    ["failed", "2026-11-04T10:00:00.000Z"],
    ["retry", "2026-11-04T10:00:00.000Z"],
    ["merge", "rio", "old", "new"],
    ["merge", "rio", "gone", "new"],
  ]);
});
