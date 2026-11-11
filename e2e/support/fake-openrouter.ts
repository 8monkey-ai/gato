type ChatMessage = { role: string; content: unknown; tool_calls?: unknown[] };

export type LlmRequest = {
  model: string;
  stream: boolean;
  messages: ChatMessage[];
  tools?: {
    function: { name: string; description?: string; parameters: unknown };
  }[];
  metadata?: Record<string, string>;
};

export type LlmReply = {
  text?: string;
  chunkDelayMs?: number;
  toolCalls?: { name: string; args: unknown }[];
  status?: number;
  hangMs?: number;
};

type Handler = (request: LlmRequest) => LlmReply | Promise<LlmReply>;

export function systemText(request: LlmRequest): string {
  return contentText(
    request.messages.find((m) => m.role === "system")?.content,
  );
}

export function lastUserText(request: LlmRequest): string {
  const user = request.messages.findLast((m) => m.role === "user");
  return contentText(user?.content);
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { type?: string; text?: string }) =>
      part.type === "text" ? part.text : `<${part.type}>`,
    )
    .join(" ");
}

export const isSummaryCall = (r: LlmRequest) =>
  systemText(r).startsWith("Primary Language used");
export const isPreparationCall = (r: LlmRequest) =>
  /^(Describe this image|Read this document|Transcribe this audio)/.test(
    systemText(r),
  );
export const isMainCall = (r: LlmRequest) => r.stream === true;

export function startFakeOpenRouter(
  models = ["test/agent", "test/summary", "test/vision", "test/audio"],
) {
  const requests: LlmRequest[] = [];
  let handler: Handler = () => ({ text: "Hello from the agent." });
  let counter = 0;
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    routes: {
      "/api/v1/models": () =>
        Response.json({ data: models.map((id) => ({ id })) }),
      "/api/v1/chat/completions": {
        POST: async (request) => {
          const body = (await request.json()) as LlmRequest;
          requests.push(body);
          const reply = await handler(body);
          if (reply.hangMs) await Bun.sleep(reply.hangMs);
          if (reply.status)
            return new Response(
              JSON.stringify({ error: { message: "fake failure" } }),
              { status: reply.status },
            );
          const id = `gen-${++counter}`;
          return body.stream
            ? streamReply(id, body.model, reply, request.signal)
            : jsonReply(id, body.model, reply);
        },
      },
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/api/v1`,
    requests,
    mainRequests: () => requests.filter(isMainCall),
    respond(next: Handler) {
      handler = next;
    },
    stop: () => server.stop(true),
  };
}

const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };

function toolCallsOf(reply: LlmReply) {
  return (reply.toolCalls ?? []).map((call, index) => ({
    index,
    id: `call_${index}_${crypto.randomUUID().slice(0, 6)}`,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  }));
}

function jsonReply(id: string, model: string, reply: LlmReply) {
  const toolCalls = toolCallsOf(reply);
  return Response.json({
    id,
    object: "chat.completion",
    created: 1,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: reply.text ?? "",
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
      },
    ],
    usage,
  });
}

function streamReply(
  id: string,
  model: string,
  reply: LlmReply,
  signal: AbortSignal,
) {
  const chunk = (delta: object, finish: string | null = null, extra = {}) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  const pieces = (reply.text ?? "").match(/\S+\s*|\s+/g) ?? [];
  const toolCalls = toolCallsOf(reply);
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        controller.enqueue(
          encoder.encode(chunk({ role: "assistant", content: "" })),
        );
        for (const piece of pieces) {
          if (reply.chunkDelayMs) await Bun.sleep(reply.chunkDelayMs);
          if (signal.aborted) return controller.close();
          controller.enqueue(encoder.encode(chunk({ content: piece })));
        }
        if (toolCalls.length)
          controller.enqueue(encoder.encode(chunk({ tool_calls: toolCalls })));
        controller.enqueue(
          encoder.encode(
            chunk({}, toolCalls.length ? "tool_calls" : "stop", { usage }),
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch {
        // The client closed the stream.
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
}
