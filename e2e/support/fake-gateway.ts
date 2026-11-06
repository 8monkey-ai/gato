import { readBody } from "./recorder.ts";

export interface ChatRequest {
  model: string;
  stream?: boolean;
  messages: { role: string; content: unknown; tool_calls?: unknown }[];
  tools?: { function: { name: string } }[];
}

export interface Reply {
  text?: string;
  toolCalls?: { name: string; args: unknown }[];
  /** Milliseconds between streamed chunks. */
  chunkDelayMs?: number;
  status?: number;
}

type Script = (request: ChatRequest, index: number) => Reply;

const encoder = new TextEncoder();

function chunk(delta: unknown, finish: string | null = null) {
  const body = {
    id: "gen-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  return encoder.encode(`data: ${JSON.stringify(body)}\n\n`);
}

function toolCalls(reply: Reply) {
  return reply.toolCalls?.map((call, index) => ({
    index,
    id: `call_${index}_${Math.random().toString(36).slice(2)}`,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  }));
}

function stream(reply: Reply): Response {
  const words = (reply.text ?? "").split(/(?<=\s)/);
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(chunk({ role: "assistant", content: "" }));
      for (const word of words) {
        if (reply.chunkDelayMs) await Bun.sleep(reply.chunkDelayMs);
        controller.enqueue(chunk({ content: word }));
      }
      const calls = toolCalls(reply);
      if (calls) controller.enqueue(chunk({ tool_calls: calls }));
      controller.enqueue(chunk({}, calls ? "tool_calls" : "stop"));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

function complete(reply: Reply): Response {
  const calls = toolCalls(reply);
  return Response.json({
    id: "gen-1",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: reply.text ?? "",
          tool_calls: calls,
        },
        finish_reason: calls ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

/** A fake model gateway with the OpenRouter chat completions interface. */
export function fakeGateway(models: string[]) {
  const requests: ChatRequest[] = [];
  let script: Script = () => ({ text: "Hello." });
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    routes: {
      "/models": () => Response.json({ data: models.map((id) => ({ id })) }),
      "/chat/completions": async (request) => {
        const body = (await readBody(request)) as ChatRequest;
        requests.push(body);
        const reply = script(body, requests.length - 1);
        if (reply.status)
          return Response.json(
            { error: { message: "fake failure", code: reply.status } },
            { status: reply.status },
          );
        return body.stream ? stream(reply) : complete(reply);
      },
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    requests,
    script(next: Script) {
      script = next;
    },
    /** Requests for the given model. */
    callsFor: (model: string) => requests.filter((r) => r.model === model),
    stop: () => server.stop(true),
  };
}
