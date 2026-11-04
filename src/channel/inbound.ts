import { z } from "zod";

import {
  chatStatus,
  instant,
  ownerKind,
  role,
  sender,
  textPart,
} from "../conversation/events.ts";
import { folderName } from "../conversation/state.ts";

/**
 * The chat is `chatKey` within the connection of the adapter that sent the event.
 * `at` is the original sent time. `dedupKey` is the same each time the platform repeats a notification.
 */
const base = { chatKey: folderName, dedupKey: z.string().min(1), at: instant };

export const inboundEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    ...base,
    role,
    sender,
    parts: z.array(textPart).min(1),
    /** The platform's message id. An echo of an own send carries the id of that send. */
    externalId: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("owner"), ...base, owner: ownerKind }),
  z.object({ type: z.literal("status"), ...base, status: chatStatus }),
  z.object({
    type: z.literal("note"),
    ...base,
    author: z.enum(["operator", "unknown"]),
    text: z.string(),
  }),
  z.object({
    type: z.literal("delivery-update"),
    ...base,
    externalId: z.string().min(1),
    delivery: z.enum(["confirmed", "failed"]),
  }),
]);
/** A notification an adapter made from a platform payload. */
export type InboundEvent = z.input<typeof inboundEvent>;

export type AcceptResult = "saved" | "duplicate" | "ignored" | "malformed";

export interface InboundSink {
  /** Resolves after the event is saved durably, so the adapter can then acknowledge it. */
  accept(event: InboundEvent): Promise<AcceptResult>;
}
