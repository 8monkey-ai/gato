import { RespondIO, RespondIOError } from "@respond-io/typescript-sdk";
import type { ToolSet } from "ai";

import type { Env } from "../../config/env.ts";
import { errorText, log } from "../../log.ts";
import type { Channel, Inbox, OutgoingPart, SendResult } from "../channel.ts";
import { registerChannelType } from "../channel.ts";
import { download } from "../download.ts";
import { connectRespondMcp, readMcpSettings } from "./mcp.ts";
import { MalformedEvent, parseEvent } from "./parse.ts";
import { verifySignature } from "./signature.ts";

type Client = InstanceType<typeof RespondIO>;

const contact = (chat: string) => `id:${Number(chat)}` as const;

function sendFailure(error: unknown): SendResult {
  const status = error instanceof RespondIOError ? error.statusCode : 0;
  if (status === 0 || status >= 500) {
    return { status: "uncertain", reason: errorText(error) };
  }
  if (status === 429) {
    const seconds = (error as RespondIOError).rateLimitInfo?.retryAfter ?? 1;
    return { status: "retry", afterMs: seconds * 1000 };
  }
  return { status: "rejected", reason: errorText(error) };
}

function outgoing(part: OutgoingPart) {
  if ("text" in part) return { type: "text" as const, text: part.text };
  const attachment = { type: "video" as const, url: part.videoUrl };
  return { type: "attachment" as const, attachment };
}

async function send(
  client: Client,
  chat: string,
  part: OutgoingPart,
): Promise<SendResult> {
  try {
    const request = { message: outgoing(part) };
    const { messageId } = await client.messaging.send(contact(chat), request);
    return { status: "sent", ref: String(messageId) };
  } catch (error) {
    return sendFailure(error);
  }
}

interface WebhookOptions {
  name: string;
  signingKeys: string[];
  agentUserId: string;
  inbox: () => Inbox | undefined;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function webhook(options: WebhookOptions) {
  return async (request: Request) => {
    const inbox = options.inbox();
    if (!inbox) return new Response("Not ready", { status: 503 });
    const body = await readJson(request);
    const signature = request.headers.get("x-webhook-signature");
    if (!verifySignature(options.signingKeys, body, signature)) {
      log("warn", "respondio.webhook_rejected", { connection: options.name });
      return new Response("Invalid signature", { status: 401 });
    }
    try {
      const event = parseEvent(body, options.agentUserId);
      if (event) await inbox.handle(event);
      return Response.json({ message: "ok" });
    } catch (error) {
      if (!(error instanceof MalformedEvent)) throw error;
      log("warn", "respondio.webhook_malformed", {
        connection: options.name,
        error: error.message,
      });
      return new Response("Malformed notification", { status: 400 });
    }
  };
}

function readSettings(env: Env) {
  const signingKeys = env.list("WEBHOOK_SIGNING_KEYS");
  if (signingKeys.length === 0) {
    const name = env.name("WEBHOOK_SIGNING_KEYS");
    throw new Error(
      `Missing ${name}. Give the signing key of each respond.io webhook.`,
    );
  }
  const client = new RespondIO({
    apiToken: env.string("API_TOKEN"),
    baseUrl: env.string("API_URL", "https://api.respond.io/v2"),
    maxRetries: 1,
    timeout: 15_000,
  });
  const agentUserId = env.string("AGENT_USER_ID");
  return { client, signingKeys, agentUserId, mcp: readMcpSettings(env) };
}

function createRespondIo(name: string, env: Env): Channel {
  const { client, signingKeys, agentUserId, mcp } = readSettings(env);
  let inbox: Inbox | undefined;
  let contactTools: ((chat: string) => ToolSet) | undefined;
  const route = webhook({ name, signingKeys, agentUserId, inbox: () => inbox });
  return {
    maxMessageLength: 4096,
    nativeAssignment: true,
    videoAttachments: true,
    routes: { [`/webhooks/${name}`]: route },
    async start(receiver) {
      if (mcp) contactTools = await connectRespondMcp(name, mcp);
      inbox = receiver;
    },
    stop: () => {
      inbox = undefined;
      return Promise.resolve();
    },
    send: (chat, part) => send(client, chat, part),
    retrieve: download,
    notes: {
      add: async (chat, text) =>
        void (await client.comments.create(contact(chat), { text })),
    },
    tools: (chat) => Promise.resolve(contactTools?.(chat) ?? {}),
    labels: {
      add: async (chat, labels) =>
        void (await client.contacts.addTags(contact(chat), labels)),
      list: async (chat) =>
        (await client.contacts.get(contact(chat))).tags ?? [],
    },
  };
}

registerChannelType("respondio", createRespondIo);
