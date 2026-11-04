import { z } from "zod";

import type { Author, Owner } from "../../record/types.ts";
import type { InboundEvent } from "../channel.ts";
import { mapContent } from "./message-content.ts";
import {
  type Contact,
  handledEventTypes,
  type MessagePayload,
  type WebhookPayload,
  webhookPayload,
} from "./payloads.ts";

export type MapResult =
  InboundEvent | { ignore: string } | { malformed: string };
type MapContext = { agentUserId: string; receivedAt: Date };

const eventType = z.looseObject({ event_type: z.string() });

const toDate = (timestamp: number) =>
  new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);

export function ownerOf(
  assignee: Contact["assignee"],
  agentUserId: string,
): { owner: Owner; assigneeId?: string } {
  if (assignee?.id == null) return { owner: "none" };
  const assigneeId = String(assignee.id);
  return { owner: assigneeId === agentUserId ? "agent" : "human", assigneeId };
}

function operator(payload: MessagePayload): Author {
  const { sender, user } = payload;
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ");
  return {
    role: "operator",
    id: (sender?.userId ?? user?.id)?.toString(),
    name: name === "" ? undefined : name,
  };
}

function outgoingAuthor(payload: MessagePayload, agentUserId: string): Author {
  const { sender } = payload;
  if (!sender) return { role: "operator" };
  if (sender.source === "workflow")
    return { role: "workflow", id: sender.workflowId?.toString() };
  if (sender.source === "api" || String(sender.userId) === agentUserId)
    return { role: "agent" };
  return operator(payload);
}

function mapMessage(payload: MessagePayload, agentUserId: string): MapResult {
  const { message } = payload;
  const content = mapContent(message.message);
  if (content.text === undefined && content.attachments.length === 0)
    return { malformed: `empty ${message.message.type} message` };
  return {
    kind: "message",
    chatId: String(payload.contact.id),
    eventId: payload.event_id,
    message: {
      platformId: String(message.messageId),
      author:
        message.traffic === "incoming"
          ? { role: "customer" }
          : outgoingAuthor(payload, agentUserId),
      sentAt: toDate(message.timestamp),
      ...content,
    },
  };
}

function mapEvent(payload: WebhookPayload, context: MapContext): MapResult {
  const base = {
    chatId: String(payload.contact.id),
    eventId: payload.event_id,
  };
  switch (payload.event_type) {
    case "message.received":
    case "message.sent":
      return mapMessage(payload, context.agentUserId);
    case "contact.assignee.updated":
      return {
        kind: "ownership",
        ...base,
        at: context.receivedAt,
        ...ownerOf(payload.contact.assignee, context.agentUserId),
      };
    case "conversation.opened":
      return {
        kind: "status",
        ...base,
        at: toDate(payload.conversation.conversationOpenedAt),
        open: true,
      };
    case "conversation.closed":
      return {
        kind: "status",
        ...base,
        at: toDate(payload.conversation.closedTime),
        open: false,
      };
  }
}

export function mapPayload(json: unknown, context: MapContext): MapResult {
  const type = eventType.safeParse(json).data?.event_type;
  if (type === undefined) return { malformed: "event_type is missing" };
  if (!handledEventTypes.has(type))
    return { ignore: `event type ${type} is not handled` };
  const parsed = webhookPayload.safeParse(json);
  if (!parsed.success)
    return {
      malformed: parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.code}`)
        .join("; "),
    };
  return mapEvent(parsed.data, context);
}
