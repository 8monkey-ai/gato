import { z } from "zod";

import type { Role, Sender } from "../../conversation/entry.ts";
import type {
  ChannelMessage,
  ChatEvent,
  IncomingAttachment,
} from "../channel.ts";

const id = z.union([z.number(), z.string()]).transform(String);
const text = z.string().nullish();

const user = z
  .object({ id: id.nullish(), firstName: text, lastName: text })
  .nullish();

const contact = z.object({
  id,
  firstName: text,
  lastName: text,
  language: text,
  status: text,
  assignee: user,
});

const attachment = z.object({
  type: z.string(),
  url: z.string(),
  fileName: text,
  mime: text,
  mimeType: text,
  size: z.union([z.number(), z.string()]).nullish(),
  description: text,
});

const content = z.looseObject({
  type: z.string(),
  text,
  message: text,
  attachment: attachment.nullish(),
});

const message = z.object({
  messageId: id,
  traffic: z.enum(["incoming", "outgoing"]),
  timestamp: z.number(),
  message: content,
});

const payload = z.object({
  event_type: z.string(),
  contact,
  message: message.optional(),
  sender: z.object({ source: text, userId: id.nullish() }).nullish(),
  user,
});

type Payload = z.infer<typeof payload>;

const relevant = new Set([
  "message.received",
  "message.sent",
  "contact.assignee.updated",
  "conversation.opened",
  "conversation.closed",
]);

export class MalformedEvent extends Error {}

function fullName(person: {
  firstName?: string | null;
  lastName?: string | null;
}) {
  return (
    [person.firstName, person.lastName].filter(Boolean).join(" ") || undefined
  );
}

function categoryOf(
  type: string,
  mediaType: string | undefined,
): IncomingAttachment["category"] {
  if (type === "image" || type === "sticker") return "image";
  if (type === "audio" || type === "video") return type;
  const top = mediaType?.split("/")[0];
  return top === "image" || top === "audio" || top === "video"
    ? top
    : "document";
}

function attachmentsOf(
  body: z.infer<typeof content>,
): IncomingAttachment[] | undefined {
  const file = body.attachment;
  if (file) {
    const mediaType = file.mimeType ?? file.mime ?? undefined;
    return [
      {
        category: categoryOf(file.type, mediaType),
        source: file.url,
        mediaType,
        name: file.fileName ?? undefined,
        size:
          file.size === null || file.size === undefined
            ? undefined
            : Number(file.size),
        description: file.description || undefined,
      },
    ];
  }
  if (body.type === "text" || body.type === "email") return undefined;
  return [{ category: "other", source: "", name: `${body.type} message` }];
}

function classify(
  event: Payload,
  agentUserId: string,
): { role: Role; sender?: Sender } {
  if (event.message?.traffic === "incoming") return { role: "customer" };
  const source = event.sender?.source;
  if (source === "workflow") return { role: "workflow" };
  if (source === "api" || event.sender?.userId === agentUserId)
    return { role: "agent" };
  return { role: "operator", sender: operatorOf(event) };
}

function operatorOf(event: Payload): Sender {
  const name = event.user ? fullName(event.user) : undefined;
  const userId = event.sender?.userId ?? event.user?.id ?? undefined;
  return userId || name ? { id: userId, name } : "unknown";
}

function toMessage(
  event: Payload,
  agentUserId: string,
): ChannelMessage | undefined {
  const item = event.message;
  if (!item) return undefined;
  const ms = item.timestamp < 1e12 ? item.timestamp * 1000 : item.timestamp;
  return {
    ref: item.messageId,
    at: new Date(ms),
    text: item.message.text ?? item.message.message ?? undefined,
    attachments: attachmentsOf(item.message),
    ...classify(event, agentUserId),
  };
}

export function assigneeOf(
  assigneeId: string | null | undefined,
  agentUserId: string,
) {
  if (!assigneeId) return "none";
  return assigneeId === agentUserId ? "agent" : "human";
}

function ownershipOf(
  event: Payload,
  agentUserId: string,
): ChatEvent["ownership"] {
  const assignee = assigneeOf(event.contact.assignee?.id, agentUserId);
  if (event.event_type === "conversation.closed")
    return { assignee, open: false };
  if (event.event_type === "conversation.opened")
    return { assignee, open: true };
  return event.contact.status
    ? { assignee, open: event.contact.status === "open" }
    : { assignee };
}

export function parseEvent(
  body: unknown,
  agentUserId: string,
): ChatEvent | undefined {
  const type = (body as { event_type?: unknown } | null)?.event_type;
  if (typeof type === "string" && !relevant.has(type)) return undefined;
  const parsed = payload.safeParse(body);
  if (!parsed.success) throw new MalformedEvent(z.prettifyError(parsed.error));
  const event = parsed.data;
  if (event.event_type.startsWith("message.") && !event.message) {
    throw new MalformedEvent("A message notification has no message.");
  }
  const name = fullName(event.contact);
  const profile: Record<string, string> = {};
  if (name) profile.name = name;
  if (event.contact.language) profile.language = event.contact.language;
  return {
    chat: event.contact.id,
    ownership: ownershipOf(event, agentUserId),
    profile,
    message: toMessage(event, agentUserId),
  };
}
