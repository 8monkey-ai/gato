type Sent = {
  method: string;
  chat_id: string;
  text?: string;
  media?: string;
  at: number;
};
type Failure = { method: string; status: number; after: number };
type Body = Record<string, unknown>;

const sendMethods = {
  sendMessage: "text",
  sendPhoto: "photo",
  sendVideo: "video",
  sendAudio: "audio",
  sendDocument: "document",
} as const;

const ok = (result: unknown) => Response.json({ ok: true, result });

function createState(token: string) {
  return {
    token,
    updates: [] as { update_id: number; message: object }[],
    sent: [] as Sent[],
    actions: [] as { chat_id: string; at: number }[],
    files: new Map<string, Uint8Array>(),
    failures: [] as Failure[],
    nextUpdate: 1,
    nextMessage: 1000,
    wake: () => {},
  };
}

type State = ReturnType<typeof createState>;

function send(state: State, method: keyof typeof sendMethods, body: Body) {
  const index = state.failures.findIndex((f) => f.method === method);
  const failure = state.failures[index];
  if (failure && failure.after-- <= 0) {
    state.failures.splice(index, 1);
    const error = {
      ok: false,
      error_code: failure.status,
      description: "fake refusal",
    };
    return Response.json(error, { status: failure.status });
  }
  const field = sendMethods[method];
  const value = String(body[field]);
  const chat_id = String(body.chat_id);
  state.sent.push({
    method,
    chat_id,
    ...(field === "text" ? { text: value } : { media: value }),
    at: Date.now(),
  });
  const chat = { id: Number(body.chat_id), type: "private" };
  return ok({
    message_id: state.nextMessage++,
    date: Math.floor(Date.now() / 1000),
    chat,
  });
}

async function call(state: State, method: string, body: Body) {
  if (method in sendMethods)
    return send(state, method as keyof typeof sendMethods, body);
  if (method === "getMe") {
    return ok({
      id: Number(state.token.split(":")[0]),
      is_bot: true,
      first_name: "Gato",
      username: "gato_bot",
    });
  }
  if (method === "getUpdates") {
    const pending = () =>
      state.updates.filter((u) => u.update_id >= Number(body.offset ?? 0));
    if (!pending().length)
      await new Promise<void>(
        (resolve) => ((state.wake = resolve), setTimeout(resolve, 300)),
      );
    return ok(pending());
  }
  if (method === "sendChatAction") {
    state.actions.push({ chat_id: String(body.chat_id), at: Date.now() });
    return ok(true);
  }
  if (method === "getFile")
    return ok({
      file_id: body.file_id,
      file_unique_id: "u",
      file_path: `files/${String(body.file_id)}`,
    });
  return new Response("not found", { status: 404 });
}

async function handle(state: State, request: Request) {
  const url = new URL(request.url);
  const file = /^\/file\/bot[^/]+\/files\/(.+)$/.exec(url.pathname)?.[1];
  if (file) {
    const bytes = state.files.get(decodeURIComponent(file));
    return bytes
      ? new Response(bytes)
      : new Response("missing", { status: 404 });
  }
  const method = /^\/bot[^/]+\/(\w+)$/.exec(url.pathname)?.[1];
  if (!method || !url.pathname.startsWith(`/bot${state.token}/`))
    return new Response("not found", { status: 404 });
  const body = (await request.json().catch(() => ({}))) as Body;
  return call(state, method, body);
}

export function startFakeTelegram(token = "111:TEST-TOKEN") {
  const state = createState(token);
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: (request) => handle(state, request),
  });
  return {
    token,
    connectionId: `telegram-${token.split(":")[0]}`,
    apiUrl: `http://127.0.0.1:${server.port}`,
    sent: state.sent,
    actions: state.actions,
    files: state.files,
    failNext(method: string, status: number, after = 0) {
      state.failures.push({ method, status, after });
    },
    push(chatId: number, message: Body, date = Math.floor(Date.now() / 1000)) {
      const message_id = state.nextMessage++;
      const from = { id: chatId, is_bot: false, first_name: "Ana" };
      const chat = { id: chatId, type: "private" };
      state.updates.push({
        update_id: state.nextUpdate++,
        message: { message_id, date, chat, from, ...message },
      });
      state.wake();
      return message_id;
    },
    stop: () => server.stop(true),
  };
}

export type FakeTelegram = ReturnType<typeof startFakeTelegram>;
