import { expect, test } from "bun:test";

import { createRespondioApi, type Fetch } from "./api.ts";

type Call = { url: string; method?: string; headers?: unknown; body?: unknown };

function api(answer: () => Promise<Response>, channelId?: number) {
  const calls: Call[] = [];
  const fetch: Fetch = (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return answer();
  };
  const client = createRespondioApi({
    apiUrl: "https://api.test/v2",
    apiToken: "tok",
    channelId,
    fetch,
    now: () => new Date("2026-11-04T10:00:00.000Z"),
  });
  return { client, calls };
}

const reply =
  (status: number, body: unknown, headers?: Record<string, string>) => () =>
    Promise.resolve(Response.json(body, { status, headers }));

test("sends text with the bearer token and maps the message id", async () => {
  const { client, calls } = api(reply(200, { messageId: 1262965213 }), 5);
  expect(await client.sendText("12", "Hello")).toEqual({
    status: "sent",
    platformId: "1262965213",
    sentAt: new Date("2026-11-04T10:00:00.000Z"),
  });
  expect(calls).toEqual([
    {
      url: "https://api.test/v2/contact/id:12/message",
      method: "POST",
      headers: {
        Authorization: "Bearer tok",
        "Content-Type": "application/json",
      },
      body: { channelId: 5, message: { type: "text", text: "Hello" } },
    },
  ]);
});

test("sends a video as an attachment on the last interacted channel", async () => {
  const { client, calls } = api(reply(200, { messageId: 1 }));
  await client.sendVideo("12", "https://videos.test/a.mp4");
  expect(calls[0]?.body).toEqual({
    message: {
      type: "attachment",
      attachment: { type: "video", url: "https://videos.test/a.mp4" },
    },
  });
});

test("a rate limit is a failure that is safe to retry after Retry-After", async () => {
  const { client } = api(
    reply(
      429,
      { code: 429, message: "Too Many Requests" },
      { "Retry-After": "3" },
    ),
  );
  expect(await client.sendText("12", "Hi")).toEqual({
    status: "failed",
    error:
      'respond.io answered 429: {"code":429,"message":"Too Many Requests"}',
    retryAfterMs: 3000,
  });
});

test("a queued resource without Retry-After waits one second", async () => {
  const { client } = api(reply(449, { code: 449 }));
  expect(await client.sendText("12", "Hi")).toMatchObject({
    status: "failed",
    retryAfterMs: 1000,
  });
});

test("other client errors are permanent failures", async () => {
  const { client } = api(
    reply(400, { code: 400, message: "Validation error." }),
  );
  expect(await client.sendText("12", "Hi")).toEqual({
    status: "failed",
    error:
      'respond.io answered 400: {"code":400,"message":"Validation error."}',
  });
});

test("server and network errors leave the send uncertain", async () => {
  const server = api(reply(500, { code: 500 }));
  expect(await server.client.sendText("12", "Hi")).toEqual({
    status: "uncertain",
    error: 'respond.io answered 500: {"code":500}',
  });
  const network = api(() => Promise.reject(new TypeError("fetch failed")));
  expect(await network.client.sendText("12", "Hi")).toEqual({
    status: "uncertain",
    error: "TypeError: fetch failed",
  });
});

test("comments are cut to 1000 characters and tags go as an array", async () => {
  const { client, calls } = api(reply(200, { contactId: 12 }));
  await client.addComment("12", "x".repeat(1200));
  await client.addTags("12", ["handoff", "error"]);
  expect(calls.map((call) => [call.url, call.body])).toEqual([
    ["https://api.test/v2/contact/id:12/comment", { text: "x".repeat(1000) }],
    ["https://api.test/v2/contact/id:12/tag", ["handoff", "error"]],
  ]);
});

test("a failed note or label request throws", async () => {
  const { client } = api(
    reply(404, { code: 404, message: "Contact not found" }),
  );
  await expect(client.addTags("12", ["handoff"])).rejects.toThrow(
    "respond.io answered 404",
  );
});
