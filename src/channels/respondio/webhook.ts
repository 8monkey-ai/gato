import { z } from "zod";

import { fromSeconds, type IncomingMessage } from "../channel.ts";

const attachmentKinds = {
  image: "image",
  video: "video",
  audio: "audio",
  file: "document",
} as const;

// respond.io sends null for values that it does not have, so null counts as missing.
const optional = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((v) => v ?? undefined);

const payload = z.object({
  event_type: z.string(),
  contact: z.object({ id: z.number() }),
  message: z.object({
    messageId: z.number(),
    traffic: z.enum(["incoming", "outgoing"]),
    timestamp: z.number(),
    message: z.looseObject({
      type: z.string(),
      text: optional(z.string()),
      attachment: optional(
        z.looseObject({
          type: z.string(),
          url: z.string(),
          fileName: optional(z.string()),
          mime: optional(z.string()),
          caption: optional(z.string()),
          description: optional(z.string()),
        }),
      ),
    }),
  }),
  sender: optional(
    z.looseObject({
      source: optional(z.string()),
      userId: optional(z.number()),
    }),
  ),
});

type ParsedNotification =
  | { kind: "message"; message: IncomingMessage }
  | { kind: "ignored" }
  | { kind: "malformed"; problem: string };

export function parseNotification(
  body: string,
  agentUserId: number | undefined,
): ParsedNotification {
  const json = parseJson(body);
  if (json === undefined)
    return { kind: "malformed", problem: "The body is not JSON" };
  const type = (json as { event_type?: unknown })?.event_type;
  if (type !== "message.received" && type !== "message.sent")
    return { kind: "ignored" };
  const parsed = payload.safeParse(json);
  if (!parsed.success)
    return { kind: "malformed", problem: z.prettifyError(parsed.error) };
  const { contact, message, sender } = parsed.data;
  return {
    kind: "message",
    message: {
      contact: String(contact.id),
      ref: String(message.messageId),
      at:
        message.timestamp < 1e12
          ? fromSeconds(message.timestamp)
          : new Date(message.timestamp),
      ...classify(message.traffic, sender ?? {}, agentUserId),
      ...content(message.message),
    },
  };
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function content(message: z.infer<typeof payload>["message"]["message"]) {
  const { attachment } = message;
  const text = message.text ?? attachment?.caption ?? attachment?.description;
  const kind =
    attachment &&
    attachmentKinds[attachment.type as keyof typeof attachmentKinds];
  const attachments: IncomingMessage["attachments"] = attachment
    ? [
        {
          kind: kind ?? "other",
          source: attachment.url,
          name: attachment.fileName,
          mime: attachment.mime,
        },
      ]
    : text
      ? []
      : [{ kind: "other", source: "", name: message.type }];
  return { ...(text ? { text } : {}), attachments };
}

function classify(
  traffic: "incoming" | "outgoing",
  { source, userId }: { source?: string; userId?: number },
  agentUserId: number | undefined,
): Pick<IncomingMessage, "role" | "sender"> {
  if (traffic === "incoming") return { role: "customer" };
  if (source === "workflow") return { role: "workflow" };
  if (source === "api" || (userId !== undefined && userId === agentUserId))
    return { role: "agent" };
  return { role: "operator", sender: userId ? `user:${userId}` : "unknown" };
}
