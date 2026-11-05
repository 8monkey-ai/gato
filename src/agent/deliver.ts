import type { Channel, OutgoingPart, SendResult } from "../channels/channel.ts";
import type { Delivery, MessageEntry } from "../conversation/entry.ts";
import { insertEntry } from "../conversation/record.ts";
import type { Conversation } from "../conversation/store.ts";
import { logFields, save } from "../conversation/store.ts";
import { sleep } from "../delivery/outbox.ts";
import { errorText, log } from "../log.ts";

async function sendWithRetry(
  channel: Channel,
  chat: string,
  part: OutgoingPart,
): Promise<SendResult> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await channel
      .send(chat, part)
      .catch((error: unknown): SendResult => ({
        status: "uncertain",
        reason: errorText(error),
      }));
    if (result.status !== "retry") return result;
    await sleep(result.afterMs);
  }
  return {
    status: "rejected",
    reason: "The channel kept asking to retry later.",
  };
}

function deliveryOf(entry: MessageEntry, result: SendResult): Delivery {
  if (entry.delivery === "sent" || result.status === "sent") return "sent";
  return result.status === "uncertain" ? "uncertain" : "failed";
}

export function createDeliverer(
  conversation: Conversation,
  channel: Channel,
  turn: string,
) {
  return async (part: OutgoingPart): Promise<Delivery> => {
    const entry: MessageEntry = {
      kind: "message",
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      role: "agent",
      text: "text" in part ? part.text : part.videoUrl,
      delivery: "sending",
      turn,
    };
    insertEntry(conversation.entries, entry);
    await save(conversation);
    const result = await sendWithRetry(channel, conversation.chat, part);
    const delivery = deliveryOf(entry, result);
    entry.delivery = delivery;
    if (result.status === "sent") entry.ref ??= result.ref;
    await save(conversation);
    const fields = {
      ...logFields(conversation),
      turn,
      message: entry.id,
    };
    if (delivery === "sent") log("info", "delivery.sent", fields);
    else
      log("warn", `delivery.${delivery}`, {
        ...fields,
        reason: "reason" in result ? result.reason : undefined,
      });
    return delivery;
  };
}
