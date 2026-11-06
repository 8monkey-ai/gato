import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { waitUntil, writeChat } from "./support/app.ts";
import {
  contentText,
  isSummaryCall,
  lastUserText,
  type LlmReply,
} from "./support/fake-openrouter.ts";
import { createWorld, type World } from "./support/world.ts";

let world: World;
afterEach(async () => world.close());

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString();
const history = (days: number) => `[${daysAgo(days)}] customer {"ref":"a"}
  I need 40 cups for an event

[${daysAgo(days - 0.01)}] agent {"delivery":"sent"}
  We can do that.

[${daysAgo(days - 0.02)}] agent {"delivery":"unsent"}
  Draft that never reached the customer

[${daysAgo(days - 0.03)}] note {"author":"agent"}
  Nudge
`;
const summaryFile = () =>
  join(world.dataDir, world.telegram.connectionId, "42", "summary.txt");

async function run(
  chat: string,
  summary: LlmReply,
  env: Record<string, string> = { SUMMARY_MODEL: "test/summary" },
  saved?: string,
) {
  world = await createWorld();
  await writeChat(world.dataDir, world.telegram.connectionId, "42", chat);
  if (saved) await Bun.write(summaryFile(), saved);
  world.llm.respond((request) =>
    isSummaryCall(request) ? summary : { text: "Hello again." },
  );
  await world.start(env);
  world.telegram.push(42, { text: "Hi" });
  await waitUntil(() => world.telegram.sent.length);
  const summaryCalls = world.llm.requests.filter(isSummaryCall);
  const first = world.llm.mainRequests()[0]!.messages[1]!;
  return { summaryCalls, first: [first.role, contentText(first.content)] };
}

test("§4 a first summary is generated with the summary model from history at least three days old", async () => {
  const { summaryCalls, first } = await run(history(5), {
    text: "Primary Language used in this conversation: English\n- Event order",
  });

  expect(summaryCalls.map((r) => r.model)).toEqual(["test/summary"]);
  const transcript = lastUserText(summaryCalls[0]!);
  expect(transcript).toContain("Customer: I need 40 cups for an event");
  expect(transcript).toContain("Agent: We can do that.");
  expect(transcript).not.toContain("Draft");
  expect(transcript).not.toContain("Nudge");
  expect(first).toEqual([
    "assistant",
    "[Private notes about this contact]\nPrimary Language used in this conversation: English\n- Event order",
  ]);
  expect(await Bun.file(summaryFile()).text()).toMatch(
    /^Summarized at: \S+\n\nPrimary Language used in this conversation: English\n- Event order\n$/,
  );
});

test("§4 no summary is generated while the oldest recent message is younger than three days", async () => {
  const { summaryCalls, first } = await run(history(2), { text: "unused" });
  expect(summaryCalls).toHaveLength(0);
  expect(first[0]).toBe("user");
});

test("§4 an omitted summary model uses the base model", async () => {
  const { summaryCalls } = await run(history(5), { text: "Notes" }, {});
  expect(summaryCalls.map((r) => r.model)).toEqual(["test/agent"]);
});

test("§4 a summary younger than three days is reused", async () => {
  const saved = `Summarized at: ${daysAgo(1)}\n\nSaved notes\n`;
  const { summaryCalls, first } = await run(
    history(5),
    { text: "New" },
    undefined,
    saved,
  );
  expect(summaryCalls).toHaveLength(0);
  expect(first).toEqual([
    "assistant",
    "[Private notes about this contact]\nSaved notes",
  ]);
});

test("§4 an old summary is refreshed, and empty output keeps the previous summary", async () => {
  const saved = `Summarized at: ${daysAgo(4)}\n\nSaved notes\n`;
  const { summaryCalls, first } = await run(
    history(5),
    { text: "  " },
    undefined,
    saved,
  );
  expect(summaryCalls).toHaveLength(1);
  expect(first).toEqual([
    "assistant",
    "[Private notes about this contact]\nSaved notes",
  ]);
  expect(await Bun.file(summaryFile()).text()).toBe(saved);
});

test("§4 a failed refresh continues the reply without summary and keeps the saved summary", async () => {
  const saved = `Summarized at: ${daysAgo(4)}\n\nSaved notes\n`;
  const { first } = await run(history(5), { status: 400 }, undefined, saved);
  expect(first).toEqual(["user", "I need 40 cups for an event"]);
  expect(await Bun.file(summaryFile()).text()).toBe(saved);
});
