import { readBody, type RecordedCall } from "./recorder.ts";

export const telegramToken = "123456:TEST";

interface Update {
  update_id: number;
  message: Record<string, unknown>;
}

/** A fake Telegram Bot API. Tests push customer messages; the fake records bot calls. */
export function fakeTelegram() {
  const calls: RecordedCall[] = [];
  const updates: Update[] = [];
  const files = new Map<string, Uint8Array>();
  let nextUpdate = 1;
  let nextMessage = 1000;
  let failNext: { method: string; status: number } | undefined;

  async function method(name: string, body: Record<string, unknown>) {
    if (name === "getUpdates") {
      const offset = Number(body.offset ?? 0);
      const end = Date.now() + 500;
      while (Date.now() < end && !updates.some((u) => u.update_id >= offset))
        await Bun.sleep(20);
      return updates.filter((u) => u.update_id >= offset);
    }
    if (name === "getMe")
      return { id: 1, is_bot: true, first_name: "Bot", username: "bot" };
    if (name === "getFile")
      return {
        file_id: body.file_id,
        file_path: `files/${String(body.file_id)}`,
      };
    if (name.startsWith("send") && name !== "sendChatAction")
      return {
        message_id: nextMessage++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(body.chat_id), type: "private" },
      };
    return true;
  }

  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const file = /^\/file\/bot[^/]+\/files\/(.+)$/.exec(url.pathname);
      if (file) {
        const data = files.get(file[1] ?? "");
        return data
          ? new Response(data)
          : new Response("missing", { status: 404 });
      }
      const [, , name = ""] = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname) ?? [];
      const body = ((await readBody(request)) ?? {}) as Record<string, unknown>;
      if (name !== "getUpdates")
        calls.push({ method: name, path: url.pathname, body, headers: {} });
      if (failNext?.method === name) {
        const { status } = failNext;
        failNext = undefined;
        return Response.json(
          { ok: false, error_code: status, description: "fake failure" },
          { status },
        );
      }
      return Response.json({ ok: true, result: await method(name, body) });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    calls,
    /** Texts that the bot sent, in order. */
    sent: () =>
      calls
        .filter((c) => c.method === "sendMessage")
        .map((c) => String((c.body as { text: unknown }).text)),
    push(chatId: number, message: Record<string, unknown>) {
      const id = nextMessage++;
      updates.push({
        update_id: nextUpdate++,
        message: {
          message_id: id,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: "private" },
          from: { id: chatId, is_bot: false, first_name: "Ali" },
          ...message,
        },
      });
      return id;
    },
    file(id: string, data: Uint8Array) {
      files.set(id, data);
    },
    failNext(name: string, status: number) {
      failNext = { method: name, status };
    },
    stop: () => server.stop(true),
  };
}
