import { expect, test } from "bun:test";

import { generateText, isStepCount } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import type { AgentTool, ToolOutcome } from "../tools/tool.ts";
import { toAiTools } from "./ai-tools.ts";

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function tool(execute: AgentTool["execute"]): AgentTool {
  return {
    name: "lookup",
    description: "Look up an order.",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    execute,
  };
}

async function callOnce(agentTool: AgentTool) {
  const events: unknown[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: [
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "lookup",
            input: '{"id":"7"}',
          },
        ],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage,
        warnings: [],
      },
      {
        content: [{ type: "text", text: "Done." }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      },
    ],
  });
  const tools = toAiTools([agentTool], {
    call: (callId, name, input) =>
      Promise.resolve(void events.push(["call", callId, name, input])),
    result: (callId, name, outcome: ToolOutcome) =>
      Promise.resolve(void events.push(["result", callId, name, outcome])),
  });
  await generateText({ model, prompt: "hi", tools, stopWhen: isStepCount(2) });
  const toolMessage = model.doGenerateCalls[1]?.prompt.at(-1);
  return { events, toolMessage };
}

test("a successful tool result is recorded and reaches the model", async () => {
  const { events, toolMessage } = await callOnce(
    tool(() =>
      Promise.resolve({ output: { status: "shipped" }, isError: false }),
    ),
  );
  expect(events).toEqual([
    ["call", "c1", "lookup", { id: "7" }],
    [
      "result",
      "c1",
      "lookup",
      { output: { status: "shipped" }, isError: false },
    ],
  ]);
  expect(toolMessage).toMatchObject({
    role: "tool",
    content: [
      {
        type: "tool-result",
        output: { type: "json", value: { status: "shipped" } },
      },
    ],
  });
});

test("an error outcome reaches the model as a tool error", async () => {
  const { events, toolMessage } = await callOnce(
    tool(() => Promise.resolve({ output: "Order not found", isError: true })),
  );
  expect(events.at(-1)).toEqual([
    "result",
    "c1",
    "lookup",
    { output: "Order not found", isError: true },
  ]);
  expect(toolMessage).toMatchObject({
    role: "tool",
    content: [
      {
        type: "tool-result",
        output: { type: "error-text", value: "Error: Order not found" },
      },
    ],
  });
});

test("a thrown error is recorded as an error outcome with its message", async () => {
  const { events, toolMessage } = await callOnce(
    tool(() => Promise.reject(new Error("Server down"))),
  );
  expect(events.at(-1)).toEqual([
    "result",
    "c1",
    "lookup",
    { output: "Server down", isError: true },
  ]);
  expect(toolMessage).toMatchObject({
    content: [
      {
        type: "tool-result",
        output: { type: "error-text", value: "Error: Server down" },
      },
    ],
  });
});
