import { z } from "zod";

const id = z.union([z.number(), z.string()]);
const name = z.string().nullish();

const user = z.looseObject({
  id: id.nullish(),
  firstName: name,
  lastName: name,
});

export const contactSchema = z.looseObject({
  id,
  firstName: name,
  lastName: name,
  language: z.string().nullish(),
  status: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  assignee: user.nullish(),
});

const attachment = z.looseObject({
  type: z.string().nullish(),
  url: z.string(),
  mime: z.string().nullish(),
  mimeType: z.string().nullish(),
  fileName: z.string().nullish(),
  size: z.union([z.number(), z.string()]).nullish(),
  description: z.string().nullish(),
});

// Fields that only add detail to a message: a shape that differs drops the field, not the whole webhook.
const lenient = <T extends z.ZodType>(schema: T) =>
  schema.nullish().catch(undefined);
const lenientList = <T extends z.ZodType>(item: T) =>
  lenient(z.array(item.optional().catch(undefined)));

const content = z.looseObject({
  type: z.string(),
  text: z.string().nullish(),
  attachment: attachment.nullish(),
  subject: z.string().nullish(),
  message: z.string().nullish(),
  latitude: z.number().nullish(),
  longitude: z.number().nullish(),
  address: z.string().nullish(),
  attachments: lenientList(attachment),
  title: lenient(z.string()),
  subtitle: lenient(z.string()),
  replies: lenientList(z.string()),
  buttons: lenientList(z.looseObject({ text: lenient(z.string()) })),
  template: lenient(
    z.looseObject({
      name: lenient(z.string()),
      components: lenientList(
        z.looseObject({ type: lenient(z.string()), text: lenient(z.string()) }),
      ),
    }),
  ),
  story: lenient(attachment),
});

const envelope = { event_id: z.string(), contact: contactSchema };

const messageEvent = z.looseObject({
  ...envelope,
  event_type: z.enum(["message.received", "message.sent"]),
  message: z.looseObject({
    messageId: id,
    traffic: z.enum(["incoming", "outgoing"]),
    timestamp: z.number(),
    message: content,
  }),
  sender: z
    .looseObject({
      source: z.string().nullish(),
      userId: id.nullish(),
      workflowId: id.nullish(),
    })
    .nullish(),
  user: user.nullish(),
});

const assigneeEvent = z.looseObject({
  ...envelope,
  event_type: z.literal("contact.assignee.updated"),
});

const openedEvent = z.looseObject({
  ...envelope,
  event_type: z.literal("conversation.opened"),
  conversation: z.looseObject({ conversationOpenedAt: z.number() }),
});

const closedEvent = z.looseObject({
  ...envelope,
  event_type: z.literal("conversation.closed"),
  conversation: z.looseObject({ closedTime: z.number() }),
});

export const webhookPayload = z.discriminatedUnion("event_type", [
  messageEvent,
  assigneeEvent,
  openedEvent,
  closedEvent,
]);

export const handledEventTypes = new Set<string>([
  ...messageEvent.shape.event_type.options,
  assigneeEvent.shape.event_type.value,
  openedEvent.shape.event_type.value,
  closedEvent.shape.event_type.value,
]);

export type Contact = z.infer<typeof contactSchema>;
export type MessagePayload = z.infer<typeof messageEvent>;
export type WebhookPayload = z.infer<typeof webhookPayload>;
