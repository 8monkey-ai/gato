import { ConfigError, type EnvReader } from "../../config/env.ts";
import type { Logger } from "../../log.ts";
import { connectMcp } from "../../tools/mcp-client.ts";
import type { ChannelConnection, InboundSink } from "../channel.ts";
import { registerChannelType } from "../registry.ts";
import { createRespondioApi, type RespondioApi } from "./api.ts";
import { createContactTools } from "./contact-tools.ts";
import { ownerOf } from "./mapping.ts";
import type { Contact } from "./payloads.ts";
import { type McpSettings, readRespondioSettings } from "./settings.ts";
import { webhookHandler } from "./webhook.ts";

function contactFacts(contact: Contact): Record<string, string> {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
  return {
    ...(name && { name }),
    ...(contact.language && { language: contact.language }),
  };
}

async function connectContactTools(id: string, mcp: McpSettings, log: Logger) {
  const client = await connectMcp(
    {
      id: `respondio-${id}`,
      transport: "http",
      url: mcp.url,
      headers: { Authorization: `Bearer ${mcp.token}` },
    },
    log,
  );
  return { client, toolsFor: await createContactTools(client, mcp) };
}

// Only a rejected token fails startup; respond.io being unreachable now does not.
async function checkToken(api: RespondioApi, id: string, log: Logger) {
  const accepted = await api.tokenAccepted().catch((error: unknown) => {
    log.warn("respondio.token_check_failed", { connectionId: id, error });
    return true;
  });
  if (!accepted)
    throw new ConfigError(`respond.io API token rejected for connection ${id}`);
}

function nativePorts(api: RespondioApi, agentUserId: string) {
  return {
    assignment: {
      fetchState: async (chatId: string) => {
        const contact = await api.getContact(chatId);
        return {
          ...ownerOf(contact.assignee, agentUserId),
          open: contact.status === "open",
        };
      },
    },
    notes: { add: api.addComment },
    labels: {
      add: api.addTags,
      read: async (chatId: string) => (await api.getContact(chatId)).tags ?? [],
    },
    contactContext: async (chatId: string) =>
      contactFacts(await api.getContact(chatId)),
  };
}

async function create(
  id: string,
  env: EnvReader,
  log: Logger,
): Promise<ChannelConnection> {
  const settings = readRespondioSettings(env);
  env.assertValid();
  const api = createRespondioApi(settings);
  await checkToken(api, id, log);
  const mcp =
    settings.mcp && (await connectContactTools(id, settings.mcp, log));
  let sink: InboundSink | undefined;
  return {
    id,
    maxTextLength: settings.maxTextLength,
    supportsVideo: true,
    routes: {
      [`/respondio/${id}`]: webhookHandler({
        signingKeys: settings.signingKeys,
        agentUserId: settings.agentUserId,
        sink: () => sink,
        log: log.child({ connectionId: id }),
        now: () => new Date(),
      }),
    },
    start: (inbound) => {
      sink = inbound;
      return Promise.resolve();
    },
    stop: async () => {
      sink = undefined;
      await mcp?.client.close();
    },
    send: (chatId, part) =>
      part.kind === "text"
        ? api.sendText(chatId, part.text)
        : api.sendVideo(chatId, part.url),
    fetchAttachment: api.download,
    ...nativePorts(api, settings.agentUserId),
    ...(mcp && { contactTools: mcp.toolsFor }),
  };
}

registerChannelType({ type: "respondio", create });
