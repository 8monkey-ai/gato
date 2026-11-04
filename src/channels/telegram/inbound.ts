import { z } from "zod";

import type { InboundEvent } from "../../channel/inbound.ts";

const update = z.object({
  update_id: z.int(),
  message: z
    .object({
      date: z.int(),
      chat: z.object({ id: z.int(), type: z.string() }),
      from: z
        .object({
          id: z.int(),
          first_name: z.string(),
          last_name: z.string().optional(),
        })
        .optional(),
      text: z.string().optional(),
    })
    .optional(),
});

/** The event of a text message in a private chat. For every other update, the reason to ignore it. */
export function inboundOf(body: unknown): InboundEvent | string {
  const parsed = update.safeParse(body);
  if (!parsed.success) return "malformed update";
  const { update_id, message } = parsed.data;
  if (message?.chat.type !== "private") return "not a private chat message";
  if (message.text === undefined) return "not a text message";
  const { from } = message;
  return {
    type: "message",
    chatKey: String(message.chat.id),
    dedupKey: `tg:${update_id}`,
    at: message.date * 1000,
    role: "customer",
    sender: from
      ? {
          id: String(from.id),
          name: [from.first_name, from.last_name].filter(Boolean).join(" "),
          known: true,
        }
      : { known: false },
    parts: [{ kind: "text", text: message.text }],
  };
}
