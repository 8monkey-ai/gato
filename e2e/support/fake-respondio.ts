import { createHmac } from "node:crypto";

import { readBody, type RecordedCall } from "./recorder.ts";

export const signingKey = "signing-key";
export const agentUserId = 77;

function sign(body: string): string {
  return createHmac("sha256", signingKey).update(body).digest("base64");
}

/** A fake respond.io Developer API. Contacts and assignees are set by the test. */
class FakeRespondio {
  readonly calls: RecordedCall[] = [];
  readonly assignees = new Map<number, number | null>();
  private nextMessage = 5000;
  failSend?: number;
  /** Requests to paths that end with this text fail with status 500. */
  failPath?: string;
  private readonly server = Bun.serve({
    port: 0,
    fetch: (request) => this.handle(request),
  });
  readonly url = `http://localhost:${this.server.port}/v2`;

  sent(): string[] {
    return this.calls
      .filter((c) => /\/message$/.test(c.path) && c.method === "POST")
      .map((c) => {
        const message = (
          c.body as { message: { text?: string; attachment?: { url: string } } }
        ).message;
        return message.text ?? `video:${message.attachment?.url}`;
      });
  }

  callsTo(suffix: string) {
    return this.calls.filter((c) => c.path.endsWith(suffix));
  }

  stop() {
    return this.server.stop(true);
  }

  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.replace(/^\/v2/, "");
    const body = await readBody(request);
    this.calls.push({
      method: request.method,
      path,
      body,
      headers: Object.fromEntries(request.headers),
    });
    if (this.failPath && path.endsWith(this.failPath))
      return Response.json(
        { code: 500, message: "fake failure" },
        { status: 500 },
      );
    return this.answer(request.method, path);
  }

  private answer(method: string, path: string): Response {
    if (path.startsWith("/space/user/"))
      return Response.json({ id: agentUserId, firstName: "Agent" });
    const contact = Number(/^\/contact\/id:(\d+)/.exec(path)?.[1] ?? 0);
    if (path.endsWith("/message")) return this.send();
    if (method !== "GET") return Response.json({ contactId: contact });
    const assignee = this.assignees.get(contact) ?? null;
    return Response.json({
      id: contact,
      firstName: "Siti",
      assignee: assignee && { id: assignee },
    });
  }

  private send(): Response {
    if (this.failSend) {
      const status = this.failSend;
      this.failSend = undefined;
      return Response.json(
        { code: status, message: "fake failure" },
        { status },
      );
    }
    return Response.json({ messageId: this.nextMessage++ });
  }
}

export function fakeRespondio() {
  return new FakeRespondio();
}

export type { FakeRespondio };

let nextWebhookMessage = 1;

interface EventOptions {
  contact: number;
  traffic?: "incoming" | "outgoing";
  text?: string;
  assignee?: number | null;
  source?: string;
  userId?: number;
  messageId?: number;
  timestamp?: number;
  attachment?: { type: string; url: string; fileName?: string; mime?: string };
}

function senderFields(options: EventOptions) {
  if (options.traffic !== "outgoing") return {};
  const user = options.userId
    ? { id: options.userId, firstName: "Sarah", lastName: "Lee" }
    : undefined;
  return {
    sender: { source: options.source ?? "user", userId: options.userId },
    user,
  };
}

function content(options: EventOptions) {
  return options.attachment
    ? { type: "attachment", attachment: options.attachment }
    : { type: "text", text: options.text ?? "" };
}

export function messageEvent(options: EventOptions) {
  const traffic = options.traffic ?? "incoming";
  const assignee = options.assignee
    ? { id: options.assignee, firstName: "Op" }
    : null;
  return {
    event_type: traffic === "incoming" ? "message.received" : "message.sent",
    event_id: crypto.randomUUID(),
    contact: {
      id: options.contact,
      firstName: "Siti",
      lastName: "Aminah",
      assignee,
    },
    ...senderFields(options),
    message: {
      messageId: options.messageId ?? nextWebhookMessage++,
      channelMessageId: 1,
      contactId: options.contact,
      channelId: 1,
      traffic,
      timestamp: options.timestamp ?? Date.now(),
      message: content(options),
    },
  };
}

export async function postWebhook(
  appUrl: string,
  event: unknown,
  signature?: string,
) {
  const body = JSON.stringify(event);
  return fetch(`${appUrl}/respondio/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-signature": signature ?? sign(body),
    },
    body,
  });
}
