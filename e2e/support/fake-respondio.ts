import { createHmac } from "node:crypto";

import { readBody, type RecordedCall } from "./recorder.ts";

export const signingKey = "signing-key";
export const agentUserId = 77;

export function sign(body: string): string {
  return createHmac("sha256", signingKey).update(body).digest("base64");
}

/** A fake respond.io Developer API. Contacts and assignees are set by the test. */
class FakeRespondio {
  readonly calls: RecordedCall[] = [];
  readonly assignees = new Map<number, number | null>();
  private nextMessage = 5000;
  failSend?: number;
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
    const contact = /^\/contact\/id:(\d+)/.exec(path);
    if (path.startsWith("/space/user/"))
      return Response.json({ id: agentUserId, firstName: "Agent" });
    if (contact && path.endsWith("/message")) return this.send();
    if (contact && request.method === "GET") {
      const assignee = this.assignees.get(Number(contact[1])) ?? null;
      return Response.json({
        id: Number(contact[1]),
        firstName: "Siti",
        assignee: assignee && { id: assignee },
      });
    }
    return Response.json({ contactId: Number(contact?.[1] ?? 0) });
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

export function messageEvent(options: {
  contact: number;
  traffic?: "incoming" | "outgoing";
  text?: string;
  assignee?: number | null;
  source?: string;
  userId?: number;
  messageId?: number;
  timestamp?: number;
  attachment?: { type: string; url: string; fileName?: string; mime?: string };
}) {
  const traffic = options.traffic ?? "incoming";
  return {
    event_type: traffic === "incoming" ? "message.received" : "message.sent",
    event_id: crypto.randomUUID(),
    contact: {
      id: options.contact,
      firstName: "Siti",
      lastName: "Aminah",
      assignee: options.assignee
        ? { id: options.assignee, firstName: "Op" }
        : null,
    },
    ...(traffic === "outgoing" && {
      sender: { source: options.source ?? "user", userId: options.userId },
      user: options.userId
        ? { id: options.userId, firstName: "Sarah", lastName: "Lee" }
        : undefined,
    }),
    message: {
      messageId: options.messageId ?? nextWebhookMessage++,
      channelMessageId: 1,
      contactId: options.contact,
      channelId: 1,
      traffic,
      timestamp: options.timestamp ?? Date.now(),
      message: options.attachment
        ? { type: "attachment", attachment: options.attachment }
        : { type: "text", text: options.text ?? "" },
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
