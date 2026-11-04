import { z } from "zod";

/** Epoch milliseconds. */
export const instant = z.int().nonnegative();

const base = {
  seq: z.int().positive(),
  at: instant,
  recordedAt: instant,
  dedupKey: z.string().min(1).optional(),
};

export const role = z.enum(["customer", "operator", "workflow", "agent"]);
export type Role = z.infer<typeof role>;

const delivery = z.enum([
  "received",
  "generated",
  "attempting",
  "confirmed",
  "uncertain",
  "failed",
  "cancelled",
]);
export type DeliveryState = z.infer<typeof delivery>;

export const ownerKind = z.enum(["agent", "human", "unassigned"]);
export const ownerSource = z.enum(["channel", "local"]);
export const chatStatus = z.enum(["open", "closed"]);

export const sender = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  known: z.boolean(),
});

export const textPart = z.object({ kind: z.literal("text"), text: z.string() });

const message = z.object({
  type: z.literal("message"),
  ...base,
  messageId: z.string().min(1),
  role,
  sender,
  parts: z.array(textPart),
  delivery,
  externalId: z.string().optional(),
  internalTrigger: z.enum(["nudge", "review"]).optional(),
});

const messageUpdate = z.object({
  type: z.literal("message-update"),
  ...base,
  messageId: z.string().min(1),
  delivery: delivery.optional(),
  externalId: z.string().optional(),
});

const owner = z.object({
  type: z.literal("owner"),
  ...base,
  owner: ownerKind,
  source: ownerSource,
});

const status = z.object({
  type: z.literal("status"),
  ...base,
  status: chatStatus,
});

const label = z.object({
  type: z.literal("label"),
  ...base,
  action: z.enum(["add", "remove"]),
  label: z.string().min(1),
  origin: z.enum(["agent", "harness", "operator"]),
});

const note = z.object({
  type: z.literal("note"),
  ...base,
  kind: z.enum([
    "comment",
    "handoff",
    "error",
    "nudge",
    "skip",
    "expiry",
    "diagnostic",
  ]),
  author: z.enum(["agent", "harness", "operator", "unknown"]),
  text: z.string(),
});

export const chatEvent = z.discriminatedUnion("type", [
  message,
  messageUpdate,
  owner,
  status,
  label,
  note,
]);
export type ChatEvent = z.infer<typeof chatEvent>;

/** An event before the store gives it a sequence number and a record time. */
export type NewEvent = ChatEvent extends infer E
  ? E extends ChatEvent
    ? Omit<E, "seq" | "recordedAt">
    : never
  : never;

/** Chat order: original sent time, then record order. */
export function chatOrder(a: ChatEvent, b: ChatEvent): number {
  return a.at - b.at || a.seq - b.seq;
}
