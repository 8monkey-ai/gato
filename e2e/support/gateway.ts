export interface ToolCallScript {
  name: string;
  args: Record<string, unknown>;
}

export interface ModelScript {
  text?: string;
  toolCalls?: ToolCallScript[];
  chunkSize?: number;
  chunkDelayMs?: number;
  delayMs?: number;
  status?: number;
}

export interface ModelRequest {
  model: string;
  stream?: boolean;
  messages: {
    role: string;
    content: unknown;
    tool_calls?: unknown[];
    tool_call_id?: string;
  }[];
  tools?: { function: { name: string } }[];
}

type Handler = (request: ModelRequest) => ModelScript | Promise<ModelScript>;

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  const body = {
    id: "gen",
    model: "fake",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  return `data: ${JSON.stringify(body)}\n\n`;
}

const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

function toolCallDeltas(calls: ToolCallScript[]) {
  return calls.map((call, index) =>
    chunk({
      tool_calls: [
        {
          index,
          id: `call_${crypto.randomUUID()}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        },
      ],
    }),
  );
}

function stream(script: ModelScript, signal: AbortSignal, onEnd: () => void) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const text = script.text ?? "";
      const size = script.chunkSize ?? 8;
      controller.enqueue(
        encoder.encode(chunk({ role: "assistant", content: "" })),
      );
      for (let i = 0; i < text.length && !signal.aborted; i += size) {
        controller.enqueue(
          encoder.encode(chunk({ content: text.slice(i, i + size) })),
        );
        if (script.chunkDelayMs) await Bun.sleep(script.chunkDelayMs);
      }
      for (const delta of toolCallDeltas(script.toolCalls ?? []))
        controller.enqueue(encoder.encode(delta));
      const finish = script.toolCalls?.length ? "tool_calls" : "stop";
      const end = {
        id: "gen",
        model: "fake",
        usage,
        choices: [{ index: 0, delta: {}, finish_reason: finish }],
      };
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`),
      );
      controller.close();
      onEnd();
    },
  });
}

function complete(script: ModelScript) {
  const toolCalls = script.toolCalls?.map((call) => ({
    id: `call_${crypto.randomUUID()}`,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  }));
  const message = {
    role: "assistant",
    content: script.text ?? "",
    tool_calls: toolCalls,
  };
  return Response.json({
    id: "gen",
    model: "fake",
    usage,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls?.length ? "tool_calls" : "stop",
      },
    ],
  });
}

export function startFakeGateway() {
  const requests: ModelRequest[] = [];
  const streamEnds: number[] = [];
  let handler: Handler = () => ({ text: "Hello" });
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as ModelRequest;
      requests.push(body);
      const script = await handler(body);
      if (script.delayMs) await Bun.sleep(script.delayMs);
      if (script.status)
        return Response.json(
          { error: { message: "Fake failure", code: script.status } },
          { status: script.status },
        );
      if (!body.stream) return complete(script);
      const events = stream(script, request.signal, () =>
        streamEnds.push(Date.now()),
      );
      return new Response(events, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    url: `http://localhost:${server.port}/api/v1`,
    requests,
    streamEnds,
    reply(next: Handler | ModelScript) {
      handler = typeof next === "function" ? next : () => next;
    },
    stop: () => server.stop(true),
  };
}

export type FakeGateway = ReturnType<typeof startFakeGateway>;

export function messageText(message: ModelRequest["messages"][number]) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return (message.content as { type: string; text?: string }[])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ");
}

export function conversation(request: ModelRequest) {
  return request.messages
    .filter((message) => message.role !== "system")
    .map((message) => [message.role, messageText(message)]);
}

export function systemText(request: ModelRequest) {
  return request.messages
    .filter((message) => message.role === "system")
    .map(messageText)
    .join("\n");
}

export function toolResults(request: ModelRequest) {
  return request.messages
    .filter((message) => message.role === "tool")
    .map((message) => String(message.content));
}

export function afterTools(first: ModelScript, then: ModelScript) {
  return (request: ModelRequest) =>
    request.messages.at(-1)?.role === "tool" ? then : first;
}
