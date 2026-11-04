import { randomUUID } from "node:crypto";

import type {
  ChannelConnection,
  OutboundPart,
  SendOutcome,
} from "../channels/channel.ts";
import type { Logger } from "../log.ts";
import type { ChatRef, Delivery } from "../record/types.ts";
import type { ChatStore } from "../storage/chat-store.ts";
import { type Pacing, pauseBefore } from "./pacing.ts";

export type DeliveryConnection = Pick<
  ChannelConnection,
  "maxTextLength" | "supportsVideo" | "send" | "typing"
>;
export type DeliveryJob = {
  ref: ChatRef;
  connection: DeliveryConnection;
  turnId: string;
  signal: AbortSignal;
};
export type SenderDeps = {
  store: Pick<ChatStore, "append">;
  log: Logger;
  pacing: Pacing;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => Date;
};

type State = {
  sentParts: number;
  failed: boolean;
  index: number;
  stopError?: string;
};
// error: a store append failed, so the record of this delivery is incomplete.
export type DeliveryResult = {
  sentParts: number;
  failed: boolean;
  error?: unknown;
};
type Context = SenderDeps & DeliveryJob & { state: State };

const textOf = (part: OutboundPart) =>
  part.kind === "text" ? part.text : `[video] ${part.url}`;

async function record(
  ctx: Context,
  part: OutboundPart,
  delivery: Delivery,
  error?: string,
) {
  const id = randomUUID();
  await ctx.store.append(ctx.ref, [
    {
      type: "message",
      message: {
        id,
        author: { role: "agent" },
        sentAt: ctx.now().toISOString(),
        text: textOf(part),
        attachments: [],
        delivery,
        turnId: ctx.turnId,
        ...(error === undefined ? {} : { error }),
      },
    },
  ]);
  return id;
}

async function update(
  ctx: Context,
  messageId: string,
  fields: {
    delivery: Delivery;
    platformId?: string;
    sentAt?: string;
    error?: string;
  },
) {
  await ctx.store.append(ctx.ref, [
    { type: "message-update", messageId, ...fields },
  ]);
}

// A pacing or retry wait ends early on abort; the caller checks the signal.
const wait = (ctx: Context, ms: number) =>
  ctx.sleep(ms, ctx.signal).catch(() => undefined);

async function pace(ctx: Context, part: OutboundPart, index: number) {
  const pause = pauseBefore(index, part, ctx.pacing);
  if (pause === 0) return;
  void ctx.connection.typing?.(ctx.ref.chatId).catch(() => undefined);
  await wait(ctx, pause);
}

// A thrown send gives no proof that the part did not arrive, so it counts as uncertain.
const sendOnce = (ctx: Context, part: OutboundPart) =>
  ctx.connection
    .send(ctx.ref.chatId, part)
    .catch((error: unknown): SendOutcome => ({
      status: "uncertain",
      error: error instanceof Error ? error.message : String(error),
    }));

async function sendWithRetry(ctx: Context, part: OutboundPart) {
  let outcome = await sendOnce(ctx, part);
  for (let attempt = 1; attempt < 3; attempt++) {
    if (outcome.status !== "failed" || outcome.retryAfterMs === undefined)
      break;
    await wait(ctx, outcome.retryAfterMs);
    if (ctx.signal.aborted) return undefined;
    outcome = await sendOnce(ctx, part);
  }
  return outcome;
}

async function applyOutcome(
  ctx: Context,
  messageId: string,
  outcome: SendOutcome | undefined,
) {
  if (outcome === undefined)
    return update(ctx, messageId, { delivery: "superseded" });
  if (outcome.status === "sent") {
    ctx.state.sentParts++;
    return update(ctx, messageId, {
      delivery: "sent",
      sentAt: outcome.sentAt.toISOString(),
      ...(outcome.platformId === undefined
        ? {}
        : { platformId: outcome.platformId }),
    });
  }
  const uncertain = outcome.status === "uncertain";
  ctx.state.failed ||= !uncertain;
  ctx.state.stopError = uncertain
    ? "not sent after uncertain delivery"
    : "not sent after earlier failure";
  ctx.log.warn(uncertain ? "delivery.uncertain" : "delivery.failed", {
    connectionId: ctx.ref.connectionId,
    chatId: ctx.ref.chatId,
    turnId: ctx.turnId,
    error: outcome.error,
  });
  return update(ctx, messageId, {
    delivery: outcome.status,
    error: outcome.error,
  });
}

async function deliverPart(ctx: Context, part: OutboundPart) {
  const index = ctx.state.index++;
  const { stopError } = ctx.state;
  if (stopError !== undefined) {
    await record(ctx, part, "failed", stopError);
    return;
  }
  if (!ctx.signal.aborted) await pace(ctx, part, index);
  if (ctx.signal.aborted) {
    await record(ctx, part, "superseded");
    return;
  }
  const messageId = await record(ctx, part, "pending");
  await applyOutcome(ctx, messageId, await sendWithRetry(ctx, part));
}

export function createSender(deps: SenderDeps, job: DeliveryJob) {
  const ctx: Context = {
    ...deps,
    ...job,
    state: { sentParts: 0, failed: false, index: 0 },
  };
  let queue = Promise.resolve();
  let broken: { error: unknown } | undefined;
  return {
    enqueue(part: OutboundPart) {
      queue = queue
        .then(() => (broken ? undefined : deliverPart(ctx, part)))
        .catch((error: unknown) => {
          broken = { error };
        });
    },
    async finish(): Promise<DeliveryResult> {
      await queue;
      const { sentParts, failed } = ctx.state;
      return broken
        ? { sentParts, failed, error: broken.error }
        : { sentParts, failed };
    },
  };
}
