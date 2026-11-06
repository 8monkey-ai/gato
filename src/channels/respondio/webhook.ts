import { z } from "zod";

import type { Category } from "../../record/entries.ts";
import { categoryOf } from "../category.ts";
import type { IncomingAttachment, IncomingMessage } from "../channel.ts";

const person = z.object({
  id: z.number().optional(),
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
});

const sender = z
  .object({ source: z.string().nullish(), userId: z.number().nullish() })
  .nullish();

const messageEvent = z.object({
  event_type: z.enum(["message.received", "message.sent"]),
  contact: person.extend({ id: z.number(), assignee: person.nullish() }),
  sender,
  user: person.nullish(),
  message: z.object({
    messageId: z.number(),
    traffic: z.enum(["incoming", "outgoing"]),
    timestamp: z.number(),
    sender,
    message: z.looseObject({
      type: z.string(),
      text: z.string().nullish(),
      attachment: z
        .object({
          type: z.string(),
          url: z.string(),
          fileName: z.string().nullish(),
          mime: z.string().nullish(),
        })
        .nullish(),
    }),
  }),
});

type MessageEvent = z.infer<typeof messageEvent>;

type WebhookEvent =
  | { kind: "message"; contact: string; message: IncomingMessage }
  | { kind: "irrelevant" }
  | { kind: "malformed"; problem: string };

function fullName(value: z.infer<typeof person> | null | undefined) {
  return (
    [value?.firstName, value?.lastName].filter(Boolean).join(" ") || undefined
  );
}

function classify(event: MessageEvent, agentUserId: number) {
  if (event.message.traffic === "incoming")
    return { role: "customer" as const, sender: fullName(event.contact) };
  const { source, userId } = event.sender ?? event.message.sender ?? {};
  if (source === "workflow") return { role: "workflow" as const };
  if (source === "api" || userId === agentUserId)
    return { role: "agent" as const };
  const known = source === "user" ? fullName(event.user) : undefined;
  return { role: "operator" as const, sender: known };
}

function attachments(event: MessageEvent): IncomingAttachment[] {
  const attachment = event.message.message.attachment;
  if (event.message.message.type !== "attachment" || !attachment) return [];
  const byType: Record<string, Category> = {
    image: "image",
    audio: "audio",
    video: "video",
  };
  const mime = attachment.mime ?? undefined;
  return [
    {
      category: byType[attachment.type] ?? categoryOf(mime),
      name: attachment.fileName ?? undefined,
      mime,
      source: attachment.url,
    },
  ];
}

function text(event: MessageEvent): string {
  const content = event.message.message;
  if (content.type === "text" || content.type === "attachment")
    return content.text ?? "";
  return [content.text, `[unsupported respond.io content: ${content.type}]`]
    .filter(Boolean)
    .join("\n");
}

function toIncoming(event: MessageEvent, agentUserId: number): IncomingMessage {
  const { role, sender } = classify(event, agentUserId);
  const assignee = event.contact.assignee?.id;
  const agentOwned = assignee == null || assignee === agentUserId;
  const { timestamp } = event.message;
  return {
    ref: String(event.message.messageId),
    at: new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp),
    role,
    sender,
    text: text(event),
    attachments: attachments(event),
    answerable: role === "customer" && agentOwned,
  };
}

/** Classifies a respond.io notification. Only message notifications are relevant. */
export function parseWebhook(body: unknown, agentUserId: number): WebhookEvent {
  const type = (body as { event_type?: unknown } | null)?.event_type;
  if (type !== "message.received" && type !== "message.sent")
    return { kind: "irrelevant" };
  const parsed = messageEvent.safeParse(body);
  if (!parsed.success)
    return {
      kind: "malformed",
      problem: parsed.error.issues[0]?.message ?? "invalid",
    };
  return {
    kind: "message",
    contact: String(parsed.data.contact.id),
    message: toIncoming(parsed.data, agentUserId),
  };
}
