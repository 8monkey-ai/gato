import { createHmac } from "node:crypto";

export interface RespondCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  at: number;
}

interface Failure {
  path: RegExp;
  status: number;
  drop?: boolean;
}

export const agentUserId = 77;
export const signingKey = "test-signing-key";

export class FakeRespondIo {
  readonly calls: RespondCall[] = [];
  readonly tags = new Map<string, string[]>();
  readonly contacts = new Map<
    string,
    { assignee: number | null; status: string }
  >();
  private readonly failures: Failure[] = [];
  private nextMessage = 5000;
  private readonly server = Bun.serve({
    port: 0,
    fetch: (request) => this.handle(request),
  });

  get url() {
    return `http://localhost:${this.server.port}/v2`;
  }

  sentTexts(contact?: string) {
    return this.calls
      .filter(
        (call) =>
          call.method === "POST" &&
          /\/contact\/id:\d+\/message$/.test(call.path),
      )
      .filter(
        (call) => contact === undefined || call.path.includes(`id:${contact}/`),
      )
      .map((call) => (call.body?.message as { text?: string }).text);
  }

  comments(contact: string) {
    return this.calls
      .filter((call) => call.path.endsWith(`id:${contact}/comment`))
      .map((call) => String(call.body?.text));
  }

  fail(failure: Failure) {
    this.failures.push(failure);
  }

  async stop() {
    await this.server.stop(true);
  }

  private contact(id: string) {
    const state = this.contacts.get(id) ?? {
      assignee: agentUserId,
      status: "open",
    };
    const assignee = state.assignee === null ? null : { id: state.assignee };
    const tags = this.tags.get(id) ?? [];
    return {
      id: Number(id),
      firstName: "Ana",
      status: state.status,
      assignee,
      tags,
      created_at: 0,
    };
  }

  private addTags(id: string, tags: string[]) {
    this.tags.set(id, [...new Set([...(this.tags.get(id) ?? []), ...tags])]);
    return { contactId: Number(id) };
  }

  private respond(method: string, path: string, body: unknown) {
    const id = path.match(/\/contact\/id:(\d+)/)?.[1] ?? "";
    if (path.endsWith("/message") && method === "POST") {
      return { contactId: Number(id), messageId: this.nextMessage++ };
    }
    if (path.endsWith("/tag")) return this.addTags(id, body as string[]);
    if (path.endsWith("/comment")) return { contactId: Number(id) };
    return this.contact(id);
  }

  private async handle(request: Request) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname).replace(/^\/v2/, "");
    const text = await request.text();
    const body = text
      ? (JSON.parse(text) as Record<string, unknown>)
      : undefined;
    this.calls.push({ method: request.method, path, body, at: Date.now() });
    const index = this.failures.findIndex((item) => item.path.test(path));
    if (index >= 0) {
      const [failure] = this.failures.splice(index, 1);
      if (failure!.drop) return new Response(null, { status: 502 });
      return Response.json(
        { code: failure!.status, message: "Fake failure" },
        { status: failure!.status },
      );
    }
    return Response.json(this.respond(request.method, path, body));
  }
}

export function sign(body: unknown, key = signingKey) {
  return createHmac("sha256", key)
    .update(JSON.stringify(body))
    .digest("base64");
}

export function contactOf(
  id: string,
  assignee: number | null = agentUserId,
  status = "open",
) {
  return {
    id: Number(id),
    firstName: "Ana",
    lastName: "Cruz",
    language: "en",
    status,
    assignee:
      assignee === null
        ? null
        : { id: assignee, firstName: "Bot", lastName: "User" },
  };
}

let nextId = 100;

export function incoming(
  contact: string,
  message: Record<string, unknown>,
  options: { assignee?: number | null; at?: number; id?: number } = {},
) {
  return {
    event_type: "message.received",
    event_id: crypto.randomUUID(),
    contact: contactOf(
      contact,
      options.assignee === undefined ? agentUserId : options.assignee,
    ),
    message: {
      messageId: options.id ?? nextId++,
      traffic: "incoming",
      timestamp: options.at ?? Date.now(),
      message,
    },
    channel: { id: 1, source: "whatsapp" },
  };
}

export function outgoingEvent(
  contact: string,
  message: Record<string, unknown>,
  sender: Record<string, unknown>,
  options: { id?: number; user?: Record<string, unknown>; at?: number } = {},
) {
  return {
    event_type: "message.sent",
    event_id: crypto.randomUUID(),
    contact: contactOf(contact),
    message: {
      messageId: options.id ?? nextId++,
      traffic: "outgoing",
      timestamp: options.at ?? Date.now(),
      message,
    },
    sender,
    user: options.user,
  };
}

export function assignment(contact: string, assignee: number | null) {
  return {
    event_type: "contact.assignee.updated",
    event_id: crypto.randomUUID(),
    contact: contactOf(contact, assignee),
  };
}

export function closure(contact: string, closed: boolean) {
  return {
    event_type: closed ? "conversation.closed" : "conversation.opened",
    event_id: crypto.randomUUID(),
    contact: contactOf(contact, agentUserId, closed ? "close" : "open"),
  };
}

export async function deliver(
  appUrl: string,
  body: unknown,
  connection = "rio",
  signature = sign(body),
) {
  return await fetch(`${appUrl}/webhooks/${connection}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-signature": signature,
    },
    body: JSON.stringify(body),
  });
}
