import { readBody, type RecordedCall } from "./recorder.ts";

export const telegramToken = "123456:TEST";

interface Update {
  update_id: number;
  message: Record<string, unknown>;
}

const now = () => Math.floor(Date.now() / 1000);

/** A fake Telegram Bot API. Tests push customer messages; the fake records bot calls. */
class FakeTelegram {
  readonly calls: RecordedCall[] = [];
  private readonly updates: Update[] = [];
  private readonly files = new Map<string, Uint8Array>();
  private nextUpdate = 1;
  private nextMessage = 1000;
  private failures: { method: string; status: number; skip: number }[] = [];
  private readonly server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: (request) => this.handle(request),
  });
  readonly url = `http://localhost:${this.server.port}`;

  /** Texts that the bot sent, in order. */
  sent(): string[] {
    return this.calls
      .filter((c) => c.method === "sendMessage")
      .map((c) => String((c.body as { text: unknown }).text));
  }

  push(chatId: number, message: Record<string, unknown>): number {
    const id = this.nextMessage++;
    const chat = { id: chatId, type: "private" };
    const from = { id: chatId, is_bot: false, first_name: "Ali" };
    this.updates.push({
      update_id: this.nextUpdate++,
      message: { message_id: id, date: now(), chat, from, ...message },
    });
    return id;
  }

  file(id: string, data: Uint8Array) {
    this.files.set(id, data);
  }

  /** A later call of the method fails with the status, after the given number of successful calls. */
  fail(method: string, status: number, skip = 0) {
    this.failures.push({ method, status, skip });
  }

  stop() {
    return this.server.stop(true);
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const file = /^\/file\/bot[^/]+\/files\/(.+)$/.exec(url.pathname);
    if (file) {
      const data = this.files.get(file[1] ?? "");
      return data
        ? new Response(data)
        : new Response("missing", { status: 404 });
    }
    const [, , name = ""] = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname) ?? [];
    const body = ((await readBody(request)) ?? {}) as Record<string, unknown>;
    if (name !== "getUpdates")
      this.calls.push({ method: name, path: url.pathname, body, headers: {} });
    const failure = this.failures.findIndex(
      (f) => f.method === name && f.skip-- <= 0,
    );
    if (failure >= 0) {
      const [{ status } = { status: 500 }] = this.failures.splice(failure, 1);
      const error = {
        ok: false,
        error_code: status,
        description: "fake failure",
        parameters: { retry_after: 0 },
      };
      return Response.json(error, { status });
    }
    return Response.json({ ok: true, result: await this.result(name, body) });
  }

  private async result(name: string, body: Record<string, unknown>) {
    if (name === "getUpdates") return this.poll(Number(body.offset ?? 0));
    if (name === "getMe")
      return { id: 1, is_bot: true, first_name: "Bot", username: "bot" };
    if (name === "getFile")
      return {
        file_id: body.file_id,
        file_path: `files/${String(body.file_id)}`,
      };
    if (name === "sendChatAction" || !name.startsWith("send")) return true;
    const chat = { id: Number(body.chat_id), type: "private" };
    return { message_id: this.nextMessage++, date: now(), chat };
  }

  private async poll(offset: number) {
    const end = Date.now() + 500;
    while (Date.now() < end && !this.updates.some((u) => u.update_id >= offset))
      await Bun.sleep(20);
    return this.updates.filter((u) => u.update_id >= offset);
  }
}

export function fakeTelegram() {
  return new FakeTelegram();
}

export type { FakeTelegram };
