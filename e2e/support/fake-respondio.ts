import { createHmac } from "node:crypto";

type Sent = {
  contact: string;
  channelId?: number;
  message: {
    type: string;
    text?: string;
    attachment?: { type: string; url: string };
  };
  messageId: number;
};

const contactOf = (value: string) => value.replace(/^id:/, "");

function createState() {
  return {
    assignees: new Map<string, { id: number } | null>(),
    sent: [] as Sent[],
    comments: [] as { contact: string; text: string }[],
    tags: [] as { contact: string; tags: string[] }[],
    sendFailures: [] as number[],
    files: new Map<string, Uint8Array>(),
    sendDelayMs: 0,
    nextMessage: 5000,
  };
}

type State = ReturnType<typeof createState>;
type Request = Bun.BunRequest<"/v2/contact/:id">;

async function sendMessage(state: State, request: Request) {
  const body = (await request.json()) as Omit<Sent, "contact" | "messageId">;
  if (state.sendDelayMs) await Bun.sleep(state.sendDelayMs);
  const failure = state.sendFailures.shift();
  if (failure)
    return Response.json(
      { code: failure, message: "fake failure" },
      { status: failure },
    );
  const contact = contactOf(request.params.id);
  const messageId = state.nextMessage++;
  state.sent.push({ contact, ...body, messageId });
  return Response.json({ contactId: Number(contact), messageId });
}

function routes(state: State) {
  return {
    "/files/:name": (request: Bun.BunRequest<"/files/:name">) => {
      const bytes = state.files.get(request.params.name);
      const headers = { "content-type": "image/png" };
      return bytes
        ? new Response(bytes, { headers })
        : new Response("gone", { status: 404 });
    },
    "/v2/contact/:id": (request: Request) => {
      const contact = contactOf(request.params.id);
      return Response.json({
        id: Number(contact),
        firstName: "Ana",
        assignee: state.assignees.get(contact) ?? null,
      });
    },
    "/v2/contact/:id/message": {
      POST: (request: Request) => sendMessage(state, request),
    },
    "/v2/contact/:id/comment": {
      POST: async (request: Request) => {
        const { text } = (await request.json()) as { text: string };
        state.comments.push({ contact: contactOf(request.params.id), text });
        return Response.json({ contactId: 1, text });
      },
    },
    "/v2/contact/:id/tag": {
      POST: async (request: Request) => {
        state.tags.push({
          contact: contactOf(request.params.id),
          tags: (await request.json()) as string[],
        });
        return Response.json({ contactId: 1 });
      },
    },
  };
}

export function startFakeRespondio(signingKey = "signing-key") {
  const state = createState();
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    routes: routes(state),
    fetch: () => new Response("not found", { status: 404 }),
  });
  return {
    apiUrl: `http://127.0.0.1:${server.port}/v2`,
    fileUrl: (name: string) => `http://127.0.0.1:${server.port}/files/${name}`,
    signingKey,
    ...state,
    assign: (contact: string, userId: number | null) =>
      state.assignees.set(contact, userId === null ? null : { id: userId }),
    failNextSend: (status: number) => state.sendFailures.push(status),
    setSendDelay(ms: number) {
      state.sendDelayMs = ms;
    },
    stop: () => server.stop(true),
  };
}

let nextIncoming = 1;

export function messageEvent(options: {
  contact: number;
  traffic: "incoming" | "outgoing";
  text?: string;
  attachment?: { type: string; url: string; fileName?: string };
  sender?: { source: string; userId?: number };
  messageId?: number;
  timestamp?: number;
}) {
  const content = options.attachment
    ? {
        type: "attachment",
        attachment: options.attachment,
        ...(options.text ? { text: options.text } : {}),
      }
    : { type: "text", text: options.text ?? "" };
  return {
    event_id: crypto.randomUUID(),
    event_type:
      options.traffic === "incoming" ? "message.received" : "message.sent",
    contact: { id: options.contact, firstName: "Ana", assignee: null },
    channel: { id: 1, name: "WhatsApp", source: "whatsapp" },
    message: {
      messageId: options.messageId ?? nextIncoming++,
      channelMessageId: 1,
      contactId: options.contact,
      channelId: 1,
      traffic: options.traffic,
      timestamp: options.timestamp ?? Math.floor(Date.now() / 1000),
      message: content,
    },
    ...(options.sender ? { sender: options.sender } : {}),
  };
}

export function sign(body: string, key: string) {
  return createHmac("sha256", key).update(body).digest("base64");
}

export async function notify(
  appUrl: string,
  workspace: string,
  event: object,
  key: string,
) {
  const body = JSON.stringify(event);
  return fetch(`${appUrl}/respondio/${workspace}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-signature": sign(body, key),
    },
    body,
  });
}

export type FakeRespondio = ReturnType<typeof startFakeRespondio>;
