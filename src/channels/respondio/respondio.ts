import { verifySignature } from "@8monkey/aikit-respond-io/webhook";
import {
  RespondIO,
  RespondIOError,
  type SendMessageRequest,
} from "@respond-io/typescript-sdk";

import { envList } from "../../env.ts";
import { log } from "../../log.ts";
import { connectMcp } from "../../tools/mcp.ts";
import {
  type ChannelFactory,
  type Connection,
  type HandoffCause,
  type Outgoing,
  type Receiver,
  SendError,
} from "../channel.ts";
import { contactScope } from "./mcp-scope.ts";
import { type Settings, settingsOf } from "./settings.ts";
import { parseNotification } from "./webhook.ts";

export const respondio: ChannelFactory = async (env) =>
  Promise.all(
    envList(env.RESPONDIO_WORKSPACES).map((name) =>
      connect(settingsOf(env, name)),
    ),
  );

const contactId = (id: string) => `id:${Number(id)}` as const;

async function connect(settings: Settings): Promise<Connection> {
  const client = new RespondIO({
    apiToken: settings.apiToken,
    baseUrl: settings.apiUrl,
    maxRetries: 1,
    timeout: 15_000,
  });
  const mcp = settings.mcp;
  if (mcp) await (await connectMcp(mcp.server)).close();
  let receive: Receiver | undefined;
  const connection: Connection = {
    id: `respondio-${settings.name}`,
    label: "respond.io",
    maxTextLength: 2000,
    media: new Set(["image", "video", "audio", "document"]),
    routes: {
      [`/respondio/${settings.name}/webhook`]: (request) =>
        handleNotification(
          request,
          settings,
          receive && ((message) => receive!(connection, message)),
        ),
    },
    reconciled: Promise.resolve(),
    start: (receiver) => {
      receive = receiver;
      return Promise.resolve();
    },
    stop: () => {
      receive = undefined;
      return Promise.resolve();
    },
    download,
    ...contactActions(client, settings),
    ...(mcp && {
      contactTools: (id: string) =>
        connectMcp(mcp.server, contactScope(id, mcp)),
    }),
  };
  return connection;
}

function contactActions(client: RespondIO, settings: Settings) {
  return {
    async isAgentOwned(id: string) {
      const { assignee } = await client.contacts.get(contactId(id));
      return !assignee || assignee.id === settings.agentUserId;
    },
    send: (id: string, message: Outgoing) =>
      send(client, contactId(id), message, settings.replyChannelId),
    async note(id: string, text: string) {
      await client.comments.create(contactId(id), {
        text: text.slice(0, 1000),
      });
    },
    async handoff(id: string, reason: string, cause: HandoffCause) {
      const text = `${cause === "error" ? "Error" : "Handoff"}: ${reason}`;
      await client.comments.create(contactId(id), {
        text: text.slice(0, 1000),
      });
      const { labels } = settings;
      await client.contacts.addTags(contactId(id), [
        labels.handoff,
        labels[cause],
      ]);
    },
  };
}

async function handleNotification(
  request: Request,
  settings: Settings,
  receive: ((message: Parameters<Receiver>[1]) => Promise<void>) | undefined,
): Promise<Response> {
  const body = await request.text();
  const signature = request.headers.get("x-webhook-signature") ?? "";
  if (!settings.signingKeys.some((key) => isSigned(body, signature, key))) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!receive) return new Response("Not accepting work", { status: 503 });
  const parsed = parseNotification(body, settings.agentUserId);
  if (parsed.kind === "malformed") {
    log.warn("respondio.malformed_notification", {
      workspace: settings.name,
      problem: parsed.problem,
    });
  }
  if (parsed.kind === "message") await receive(parsed.message);
  return new Response("OK");
}

function isSigned(body: string, signature: string, key: string) {
  try {
    verifySignature(body, signature, key);
    return true;
  } catch {
    return false;
  }
}

async function download(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok)
    throw new Error(`Download failed with HTTP ${response.status}`);
  return {
    bytes: await response.bytes(),
    mime: response.headers.get("content-type") ?? undefined,
  };
}

async function send(
  client: RespondIO,
  contact: `id:${number}`,
  message: Outgoing,
  channelId?: number,
) {
  try {
    const { messageId } = await client.messaging.send(contact, {
      ...(channelId ? { channelId } : {}),
      message: toMessage(message),
    });
    return String(messageId);
  } catch (error) {
    throw toSendError(error);
  }
}

function toMessage(message: Outgoing): SendMessageRequest["message"] {
  if ("text" in message) return { type: "text", text: message.text };
  const type = message.media === "document" ? "file" : message.media;
  return {
    type: "attachment" as const,
    attachment: { type, url: message.url },
  };
}

function toSendError(error: unknown) {
  const status = error instanceof RespondIOError ? error.statusCode : 0;
  if (status === 429) {
    const retryAfter = (error as RespondIOError).rateLimitInfo?.retryAfter ?? 1;
    return new SendError(
      "respond.io rate limit",
      "temporary",
      retryAfter * 1000,
    );
  }
  const uncertain = status === 0 || status >= 500;
  return new SendError(
    `respond.io send failed with HTTP ${status}`,
    uncertain ? "uncertain" : "refused",
  );
}
