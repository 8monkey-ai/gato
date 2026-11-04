import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import type { TurnTrigger } from "../record/types.ts";
import {
  dirs,
  entries,
  failAppends,
  handoffs,
  labels,
  logged,
  ref,
  setup,
  signal,
  textStep,
  toolStep,
  turnEnd,
  useTurnFixture,
} from "./turn-fixture.ts";

useTurnFixture();

test("missing AGENTS.md fails the turn with an error handoff and no model call", async () => {
  await fs.rm(path.join(dirs().skillsDir, "AGENTS.md"));
  const { runTurn, model } = setup(textStep("Hi."));
  expect(await runTurn(ref, "customer", signal())).toBe("failed");
  expect(model.doStreamCalls).toHaveLength(0);
  const [start] = await entries("turn-start");
  expect(start).toMatchObject({ instructionsRevision: "unavailable" });
  expect(await turnEnd()).toEqual([
    ["failed", `AGENTS.md is missing in ${dirs().skillsDir}`],
  ]);
  expect(await handoffs()).toEqual([
    [
      "error",
      `The agent could not answer (failed): AGENTS.md is missing in ${dirs().skillsDir}`,
    ],
  ]);
  expect(await labels()).toEqual([["handoff", "error"]]);
});

test("a failed turn in a closed chat makes no error handoff", async () => {
  await fs.rm(path.join(dirs().skillsDir, "AGENTS.md"));
  await fs.writeFile(path.join(dirs().dataDir, "tg/42/closed"), "");
  const { runTurn } = setup(textStep("Hi."));
  expect(await runTurn(ref, "customer", signal())).toBe("failed");
  expect(await handoffs()).toEqual([]);
});

const failing = () => Promise.reject(new Error("Provider down"));

test("a model error fails the turn with an error handoff", async () => {
  const { runTurn, texts } = setup(failing);
  expect(await runTurn(ref, "customer", signal())).toBe("failed");
  expect(await turnEnd()).toEqual([["failed", "Provider down"]]);
  expect(await handoffs()).toEqual([
    ["error", "The agent could not answer (failed): Provider down"],
  ]);
  expect(texts()).toEqual([]);
});

test.each<TurnTrigger>(["nudge", "nudge-retry"])(
  "a %s turn records its prompt as the last user message and a failure does not hand off",
  async (trigger) => {
    const { runTurn, model } = setup(failing, {
      GATO_INCLUDE_TOOL_ACTIVITY: "false",
    });
    expect(await runTurn(ref, trigger, signal())).toBe("failed");
    expect((await entries("trigger")).map((e) => e.text)).toEqual(["Nudge"]);
    expect(model.doStreamCalls[0]?.prompt.at(-1)).toMatchObject({
      role: "user",
      content: [
        {
          type: "text",
          text: "[Internal trigger, not from the customer] Nudge",
        },
      ],
    });
    expect(await handoffs()).toEqual([]);
  },
);

test("reaching the step limit with pending tool calls fails with work limit reached", async () => {
  const { runTurn, model } = setup(
    [
      toolStep("read_skill", { path: "refunds/SKILL.md" }),
      toolStep("read_skill", { path: "refunds/SKILL.md" }, "c2"),
    ],
    { GATO_TURN_MAX_MODEL_CALLS: "2" },
  );
  expect(await runTurn(ref, "customer", signal())).toBe("failed");
  expect(model.doStreamCalls).toHaveLength(2);
  expect(await turnEnd()).toEqual([["failed", "work limit reached"]]);
  expect(await handoffs()).toEqual([
    ["error", "The agent could not answer (failed): work limit reached"],
  ]);
});

test("the time limit ends the turn as timed out with an error handoff", async () => {
  const { runTurn } = setup(
    ({ abortSignal }) =>
      new Promise((_resolve, reject) =>
        abortSignal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      ),
    { GATO_TURN_TIMEOUT: "20ms" },
  );
  expect(await runTurn(ref, "customer", signal())).toBe("timed-out");
  expect(await turnEnd()).toEqual([["timed-out", "time limit reached"]]);
  expect(await handoffs()).toEqual([
    ["error", "The agent could not answer (timed-out): time limit reached"],
  ]);
});

test("a failed record during delivery still ends the turn with an error handoff", async () => {
  const { runTurn, texts } = setup(textStep("Hello."));
  failAppends(
    (body) => body.type === "message" && body.message.author.role === "agent",
  );
  expect(await runTurn(ref, "customer", signal())).toBe("failed");
  expect(texts()).toEqual([]);
  expect(await turnEnd()).toEqual([["failed", "disk full"]]);
  expect(await handoffs()).toEqual([
    ["error", "The agent could not answer (failed): disk full"],
  ]);
});

test("a turn whose end cannot be recorded resolves as failed", async () => {
  const { runTurn } = setup(textStep("Hello."));
  failAppends((body) => body.type === "turn-end");
  expect(await runTurn(ref, "customer", signal())).toBe("failed");
  expect(logged().map((line) => line.event)).toContain("turn.record_failed");
});

test("a failing contact context is logged without details and the turn continues", async () => {
  const { runTurn, texts } = setup(
    textStep("Hello."),
    {},
    {
      contactContext: () => Promise.reject(new Error("secret +63 555")),
    },
  );
  expect(await runTurn(ref, "customer", signal())).toBe("completed");
  expect(texts()).toEqual(["Hello"]);
  const warning = logged().find(
    (l) => l.event === "turn.contact_context_failed",
  );
  expect(warning).toMatchObject({ level: "warn" });
  expect(JSON.stringify(warning)).not.toContain("secret");
});

test("an error hands off an unassigned chat that the shared policy lets the agent answer", async () => {
  const { runTurn } = setup(
    failing,
    { GATO_OWNERSHIP_POLICY: "shared" },
    {
      assignment: {
        fetchState: () => Promise.resolve({ owner: "none", open: true }),
      },
    },
  );
  expect(await runTurn(ref, "customer", signal())).toBe("failed");
  expect(await handoffs()).toEqual([
    ["error", "The agent could not answer (failed): Provider down"],
  ]);
});
