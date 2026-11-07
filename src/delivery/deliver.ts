import { setTimeout as sleep } from "node:timers/promises";

import {
  type Connection,
  type Outgoing,
  SendError,
} from "../channels/channel.ts";
import { log } from "../log.ts";
import type { MessageEntry } from "../record/chat-file.ts";
import type { Conversation } from "../record/store.ts";
import { type Segment, toSegments, wordCount } from "./parts.ts";

type Options = {
  conversation: Conversation;
  connection: Connection;
  turn: string;
  msPerWord: number;
  startedAt: number;
  signal: AbortSignal;
};

type SendOutcome = "sent" | "failed" | "uncertain";

export function createDelivery(options: Options) {
  let chain = Promise.resolve();
  let lastSentAt = options.startedAt;
  let delivered = 0;
  let stopped: Exclude<SendOutcome, "sent"> | undefined;

  const deliverSegment = async (segment: Segment) => {
    const due = lastSentAt + wordCount(segment) * options.msPerWord;
    if (stopped || options.signal.aborted || !(await waitUntil(due, options))) {
      return addAgentEntry(options, {
        ...content(segment),
        delivery: "unsent",
      });
    }
    let outcome = await sendRecorded(options, segment);
    if (outcome === "failed" && "media" in segment)
      outcome = await sendRecorded(options, { text: segment.url });
    if (outcome === "sent") {
      delivered++;
      lastSentAt = Date.now();
    } else if (outcome !== "unsent") {
      stopped = outcome;
    }
  };

  return {
    enqueue(part: string) {
      const { maxTextLength, media } = options.connection;
      for (const segment of toSegments(part, maxTextLength, media)) {
        chain = chain.then(() => deliverSegment(segment));
      }
    },
    recordUnsent: (text: string) =>
      addAgentEntry(options, { text, delivery: "unsent" }),
    async finish() {
      await chain;
      return { delivered, stopped };
    },
  };
}

async function waitUntil(
  due: number,
  { connection, conversation, signal }: Options,
) {
  try {
    while (Date.now() < due) {
      await connection.typing?.(conversation.contact).catch(() => undefined);
      const left = Math.max(0, Math.min(4000, due - Date.now()));
      await sleep(left, undefined, { signal });
    }
    return true;
  } catch {
    return false;
  }
}

function addAgentEntry(
  { conversation, turn }: Options,
  fields: Partial<MessageEntry>,
) {
  return conversation.lock(async (edit) => {
    edit.add({
      kind: "message",
      role: "agent",
      at: new Date().toISOString(),
      turn,
      ...fields,
    });
    await edit.save();
  });
}

function content(segment: Segment): Partial<MessageEntry> {
  return "text" in segment
    ? { text: segment.text }
    : { attachments: [{ kind: segment.media, source: segment.url }] };
}

function sendRecorded(
  { conversation, connection, turn, signal }: Options,
  segment: Outgoing,
): Promise<SendOutcome | "unsent"> {
  return conversation.lock(async (edit) => {
    const entry: MessageEntry = {
      kind: "message",
      role: "agent",
      at: new Date().toISOString(),
      turn,
      delivery: signal.aborted ? "unsent" : "sending",
      ...content(segment),
    };
    edit.add(entry);
    await edit.save();
    if (signal.aborted) return "unsent";
    const result = await sendWithRetry(
      connection,
      conversation.contact,
      segment,
    );
    entry.delivery = result.delivery;
    if (result.ref) entry.ref = result.ref;
    await edit.save();
    const where = {
      connection: connection.id,
      contact: conversation.contact,
      turn,
    };
    log.info("delivery.result", {
      ...where,
      ref: result.ref,
      delivery: result.delivery,
    });
    return result.delivery;
  });
}

async function sendWithRetry(
  connection: Connection,
  contact: string,
  segment: Outgoing,
): Promise<{ delivery: SendOutcome; ref?: string }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { delivery: "sent", ref: await connection.send(contact, segment) };
    } catch (error) {
      const outcome = error instanceof SendError ? error.outcome : "uncertain";
      log.warn("delivery.send_failed", {
        connection: connection.id,
        contact,
        outcome,
        attempt,
        error,
      });
      if (outcome !== "temporary" || attempt === 3) {
        return { delivery: outcome === "uncertain" ? "uncertain" : "failed" };
      }
      await sleep(Math.min((error as SendError).retryAfterMs, 5000));
    }
  }
}
