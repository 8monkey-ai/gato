import { expect, test } from "bun:test";

import { logEvents, waitFor } from "./support/app.ts";
import { useHarness } from "./support/fixture.ts";
import { afterTools, toolResults } from "./support/gateway.ts";
import { deliver, incoming } from "./support/respondio.ts";
import { readChat, readState } from "./support/setup.ts";

const f = useHarness(["tg", "rio"]);
const operatorChat = 999;
const handoffCall = {
  toolCalls: [
    {
      name: "handoff_to_colleague",
      args: { reason: "Customer asks for a contract change" },
    },
  ],
};

async function entriesWith(connection: string, chat: string, type: string) {
  return await waitFor(async () => {
    const entries = await readChat(f.app.dataDir, connection, chat);
    return entries.some((entry) => entry.type === type) && entries;
  });
}

test("§7 knowledge-driven handoff on respond.io: reason note, handoff and out-of-scope labels, acknowledgement stays private", async () => {
  f.gateway.reply(
    afterTools(handoffCall, { text: "A colleague will help you soon" }),
  );
  const app = await f.start();
  await deliver(
    app.url,
    incoming("41", { type: "text", text: "Change my contract" }),
  );
  await waitFor(() => f.respond.sentTexts("41").length === 1);
  expect(f.respond.sentTexts("41")).toEqual(["A colleague will help you soon"]);
  expect(f.respond.comments("41")).toEqual([
    "Customer asks for a contract change",
  ]);
  expect(f.respond.tags.get("41")).toEqual(["handoff", "out-of-scope"]);
  expect(toolResults(f.gateway.requests[1]!).join()).toContain(
    "A human is not yet confirmed as assigned.",
  );
  const note = (await readChat(app.dataDir, "rio", "41")).find(
    (entry) => entry.type === "handoff",
  );
  expect(note?.byAgent).toBe(true);
  expect(f.respond.calls.some((call) => call.path.includes("assignee"))).toBe(
    false,
  );
});

test("§7 Telegram handoff fallback: recorded locally, operator chat notified, replies pause until resumed", async () => {
  f.gateway.reply(afterTools(handoffCall, { text: "" }));
  await f.start({ CONNECTION_TG_OPERATOR_CHAT_ID: String(operatorChat) });
  f.telegram.customerMessage(1, { text: "Change my contract" });
  await entriesWith("tg", "1", "handoff");
  await waitFor(() => f.telegram.sentTexts(operatorChat).length === 1);
  expect(f.telegram.sentTexts(operatorChat)[0]).toBe(
    "Chat 1: Handoff requested (out-of-scope): Customer asks for a contract change",
  );
  const state = await waitFor(async () => {
    const current = await readState(f.app.dataDir, "tg", "1");
    return current.assignee === "human" && current;
  });
  expect(state.labels).toEqual(["handoff", "out-of-scope"]);
  f.telegram.customerMessage(1, { text: "Hello?" });
  await Bun.sleep(400);
  expect(f.gateway.requests).toHaveLength(2);
  expect(f.telegram.sentTexts(1)).toHaveLength(0);
});

test("§7 without an operator destination the logs say that operator attention is needed", async () => {
  f.gateway.reply(afterTools(handoffCall, { text: "" }));
  await f.start();
  f.telegram.customerMessage(2, { text: "Change my contract" });
  await entriesWith("tg", "2", "handoff");
  await waitFor(
    () => logEvents(f.app.logs, "operator.attention_needed").length === 1,
  );
});

test("§7 an unrecoverable error while agent-owned uses the harness path without another model call or raw error to the customer", async () => {
  f.gateway.reply({ status: 500 });
  const app = await f.start();
  await deliver(app.url, incoming("42", { type: "text", text: "Hi" }));
  const entries = await entriesWith("rio", "42", "error");
  expect(f.gateway.requests).toHaveLength(1);
  expect(f.respond.sentTexts("42")).toHaveLength(0);
  expect(f.respond.tags.get("42")).toEqual(["handoff", "error"]);
  expect(entries.find((entry) => entry.type === "error")?.text).toStartWith(
    "The agent could not answer (failed):",
  );
  expect(f.respond.comments("42")).toHaveLength(1);
});

test("§7 a failure of handoff reporting is logged without more handoffs", async () => {
  f.gateway.reply({ status: 500 });
  f.respond.fail({ path: /\/tag$/, status: 500 });
  const app = await f.start();
  await deliver(app.url, incoming("43", { type: "text", text: "Hi" }));
  await waitFor(
    () => logEvents(app.logs, "handoff.report_failed").length === 1,
  );
  await Bun.sleep(300);
  const errors = (await readChat(app.dataDir, "rio", "43")).filter(
    (entry) => entry.type === "error",
  );
  expect(errors).toHaveLength(1);
});

test("§7 a recoverable tool error is returned to the agent for correction", async () => {
  let calls = 0;
  f.gateway.reply(() => {
    calls++;
    if (calls === 1)
      return { toolCalls: [{ name: "read_skill", args: { path: "nope" } }] };
    if (calls === 2)
      return {
        toolCalls: [{ name: "read_skill", args: { path: "skills/refunds" } }],
      };
    return { text: "Fixed" };
  });
  await f.start();
  f.telegram.customerMessage(3, { text: "Refund?" });
  await waitFor(() => f.telegram.sentTexts(3).length === 1);
  const entries = await readChat(f.app.dataDir, "tg", "3");
  expect(
    entries
      .filter((entry) => entry.kind === "tool-result")
      .map((entry) => entry.error),
  ).toEqual([true, undefined]);
  expect(entries.some((entry) => entry.type === "error")).toBe(false);
});

test("§7 exhausted work limits stop the turn and use the error path", async () => {
  f.gateway.reply({
    toolCalls: [{ name: "read_skill", args: { path: "skills/refunds" } }],
  });
  await f.start({ TURN_MAX_STEPS: "2" });
  f.telegram.customerMessage(4, { text: "Loop" });
  const entries = await entriesWith("tg", "4", "error");
  expect(f.gateway.requests).toHaveLength(2);
  expect(entries.find((entry) => entry.type === "outcome")?.text).toBe(
    "Turn failed: The work limit was reached.",
  );
});

test("§7 the maximum response time stops the turn and records a timed-out outcome", async () => {
  f.gateway.reply({ text: "late", delayMs: 2000 });
  await f.start({ TURN_MAX_DURATION: "300ms" });
  f.telegram.customerMessage(5, { text: "Slow" });
  const entries = await entriesWith("tg", "5", "error");
  expect(entries.find((entry) => entry.type === "outcome")?.text).toBe(
    "Turn timed-out: The maximum response time was reached.",
  );
});

test("§7 a deliberate skip records an internal explanation and no handoff", async () => {
  f.gateway.reply({ text: "" });
  await f.start();
  f.telegram.customerMessage(6, { text: "Thanks, bye" });
  const entries = await entriesWith("tg", "6", "outcome");
  expect(entries.find((entry) => entry.type === "outcome")?.text).toBe(
    "Turn skipped: The agent chose not to reply.",
  );
  expect(
    entries.some((entry) => entry.type === "handoff" || entry.type === "error"),
  ).toBe(false);
  expect((await readState(f.app.dataDir, "tg", "6")).assignee).toBe("agent");
});

test("§6 tool activity stays private and is never sent to the customer", async () => {
  f.gateway.reply(
    afterTools(
      { toolCalls: [{ name: "read_skill", args: { path: "skills/refunds" } }] },
      { text: "Five days" },
    ),
  );
  await f.start();
  f.telegram.customerMessage(7, { text: "Refund?" });
  await waitFor(() => f.telegram.sentTexts(7).length === 1);
  await Bun.sleep(200);
  expect(f.telegram.sentTexts(7)).toEqual(["Five days"]);
});
