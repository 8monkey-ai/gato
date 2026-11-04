import { GrammyError } from "grammy";
import type { Message } from "grammy/types";

import type { SendOutcome } from "../channel.ts";

export async function sendOutcome(
  sending: Promise<Message>,
): Promise<SendOutcome> {
  try {
    const message = await sending;
    return {
      status: "sent",
      platformId: String(message.message_id),
      sentAt: new Date(message.date * 1000),
    };
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown): SendOutcome {
  if (!(error instanceof GrammyError))
    return { status: "uncertain", error: String(error) };
  if (error.error_code !== 429)
    return { status: "failed", error: error.message };
  const retryAfterMs = (error.parameters.retry_after ?? 1) * 1000;
  return { status: "failed", error: error.message, retryAfterMs };
}
