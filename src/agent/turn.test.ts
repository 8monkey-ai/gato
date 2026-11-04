import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  type Chunk,
  dirs,
  entries,
  finish,
  handoffs,
  labels,
  ref,
  setup,
  signal,
  stream,
  textStep,
  toolStep,
  turnEnd,
  useTurnFixture,
} from "./turn-fixture.ts";

useTurnFixture();

test("a customer message produces paragraph parts sent in order", async () => {
  const { runTurn, texts } = setup(
    textStep("Hello there.\n\nHow can I", " help you?"),
  );
  expect(await runTurn(ref, "customer", signal())).toBe("completed");
  expect(texts()).toEqual(["Hello there", "How can I help you?"]);
  const [start] = await entries("turn-start");
  expect(start).toMatchObject({ trigger: "customer", inputThroughSeq: 1 });
  expect(await turnEnd()).toEqual([["completed", undefined]]);
});

test("a read_skill call is recorded and the next step is delivered", async () => {
  const { runTurn, model, texts } = setup([
    toolStep("read_skill", { path: "refunds/SKILL.md" }),
    textStep("Refunds take 5 days."),
  ]);
  expect(await runTurn(ref, "customer", signal())).toBe("completed");
  const instructions = model.doStreamCalls[0]?.prompt[0];
  expect(instructions).toMatchObject({ role: "system" });
  expect(JSON.stringify(instructions)).toContain("- refunds: Refund rules.");
  const [call, result] = await entries("tool-call", "tool-result");
  expect(call).toMatchObject({
    callId: "c1",
    name: "read_skill",
    input: { path: "refunds/SKILL.md" },
  });
  expect(result).toMatchObject({
    callId: "c1",
    name: "read_skill",
    output:
      "---\nname: refunds\ndescription: Refund rules.\n---\nRefunds take 5 days.\n",
    isError: false,
  });
  expect(texts()).toEqual(["Refunds take 5 days"]);
});

test("the handoff tool records the handoff and its labels and sends nothing", async () => {
  const { runTurn, texts } = setup([
    toolStep("handoff_to_colleague", { reason: "Customer asks for a manager" }),
    stream([finish("stop")]),
  ]);
  expect(await runTurn(ref, "customer", signal())).toBe("completed");
  expect(await handoffs()).toEqual([["tool", "Customer asks for a manager"]]);
  expect(await labels()).toEqual([["handoff", "out-of-scope"]]);
  expect(texts()).toEqual([]);
});

test("an interruption stops the stream and later parts are not sent", async () => {
  const controller = new AbortController();
  const { runTurn, texts, onSend } = setup(({ abortSignal }) =>
    Promise.resolve({
      stream: new ReadableStream<Chunk>({
        start(c) {
          c.enqueue({ type: "text-start", id: "t" });
          c.enqueue({ type: "text-delta", id: "t", delta: "First.\n\nSecond" });
          abortSignal?.addEventListener("abort", () =>
            c.error(abortSignal.reason),
          );
        },
      }),
    }),
  );
  onSend.push(() => controller.abort("interrupted"));
  expect(await runTurn(ref, "customer", controller.signal)).toBe("interrupted");
  expect(texts()).toEqual(["First"]);
  expect(await turnEnd()).toEqual([["interrupted", undefined]]);
  expect(await handoffs()).toEqual([]);
});

test("a reply without text is skipped with a private note", async () => {
  const { runTurn } = setup(stream([finish("stop")]));
  expect(await runTurn(ref, "customer", signal())).toBe("skipped");
  expect(await turnEnd()).toEqual([["skipped", "no reply generated"]]);
  expect((await entries("note")).map((e) => [e.by, e.kind, e.text])).toEqual([
    ["agent", "skip", "No reply generated"],
  ]);
});

test("a paused chat is not eligible and the model is not called", async () => {
  await fs.writeFile(path.join(dirs().dataDir, "tg/42/paused"), "");
  const { runTurn, model } = setup(textStep("Hi."));
  expect(await runTurn(ref, "customer", signal())).toBe("skipped");
  expect(model.doStreamCalls).toHaveLength(0);
  expect(await turnEnd()).toEqual([["skipped", "not eligible"]]);
});
