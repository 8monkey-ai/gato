export interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
  at: number;
  ok: boolean;
}

interface Failure {
  method: string;
  code?: number;
  description?: string;
  drop?: boolean;
  retryAfter?: number;
  skip?: number;
}

type Body = Record<string, unknown>;

export class FakeTelegram {
  readonly token = "123:fake";
  readonly calls: TelegramCall[] = [];
  readonly files = new Map<string, Uint8Array>();
  private readonly updates: { update_id: number }[] = [];
  private readonly failures: Failure[] = [];
  private nextUpdate = 1;
  private nextMessage = 1000;
  private readonly server = Bun.serve({
    port: 0,
    fetch: (request) => this.handle(request),
  });

  get apiRoot() {
    return `http://localhost:${this.server.port}`;
  }

  sentTexts(chat?: number) {
    return this.calls
      .filter((call) => call.ok && call.method === "sendMessage")
      .filter(
        (call) => chat === undefined || Number(call.body.chat_id) === chat,
      )
      .map((call) => String(call.body.text));
  }

  customerMessage(chat: number, message: Body, messageId = this.nextMessage++) {
    const update = {
      update_id: this.nextUpdate++,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chat, type: "private" },
        from: { id: chat, is_bot: false, first_name: "Ana" },
        ...message,
      },
    };
    this.updates.push(update);
    return update;
  }

  repeat(update: object) {
    this.updates.push({ ...update, update_id: this.nextUpdate++ });
  }

  fail(failure: Failure) {
    this.failures.push(failure);
  }

  async stop() {
    await this.server.stop(true);
  }

  private async poll(offset: number) {
    const deadline = Date.now() + 300;
    while (Date.now() < deadline) {
      const pending = this.updates.filter(
        (update) => update.update_id >= offset,
      );
      if (pending.length > 0) return pending;
      await Bun.sleep(20);
    }
    return [];
  }

  private sent(body: Body) {
    return {
      message_id: this.nextMessage++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(body.chat_id), type: "private" },
      text: body.text,
    };
  }

  private takeFailure(method: string) {
    const index = this.failures.findIndex(
      (item) => item.method === method && !(item.skip && item.skip-- > 0),
    );
    return index >= 0 ? this.failures.splice(index, 1)[0] : undefined;
  }

  private async result(method: string, body: Body) {
    const results: Record<string, () => unknown> = {
      getMe: () => ({
        id: 42,
        is_bot: true,
        first_name: "Gato",
        username: "gato_bot",
      }),
      getUpdates: () => this.poll(Number(body.offset ?? 0)),
      sendMessage: () => this.sent(body),
      sendVideo: () => this.sent(body),
      getFile: () => ({
        file_id: body.file_id,
        file_path: `files/${String(body.file_id)}`,
      }),
    };
    return (await results[method]?.()) ?? true;
  }

  private async call(method: string, body: Body) {
    const failure = this.takeFailure(method);
    if (method !== "getUpdates")
      this.calls.push({ method, body, at: Date.now(), ok: !failure });
    if (failure?.drop) return new Response(null, { status: 502 });
    if (failure) {
      const parameters = failure.retryAfter
        ? { retry_after: failure.retryAfter }
        : undefined;
      const description = failure.description ?? "Bad Request";
      return Response.json({
        ok: false,
        error_code: failure.code ?? 400,
        description,
        parameters,
      });
    }
    return Response.json({
      ok: true,
      result: await this.result(method, body),
    });
  }

  private async handle(request: Request) {
    const path = new URL(request.url).pathname;
    const file = path.match(/^\/file\/bot[^/]+\/files\/(.+)$/)?.[1];
    if (file) {
      const data = this.files.get(file);
      return data
        ? new Response(data)
        : new Response("missing", { status: 404 });
    }
    const text = await request.text();
    return this.call(
      path.split("/").at(-1)!,
      text ? (JSON.parse(text) as Body) : {},
    );
  }
}

export function startFakeTelegram() {
  return new FakeTelegram();
}
