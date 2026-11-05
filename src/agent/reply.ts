import type { LanguageModel, ModelMessage, ToolSet } from "ai";

import type { Channel, OutgoingPart } from "../channels/channel.ts";
import type { DeliverySettings } from "../config/settings.ts";
import type { Delivery, EntryInput } from "../conversation/entry.ts";
import type { Conversation } from "../conversation/store.ts";
import { TurnStop } from "../conversation/turns.ts";
import { createOutbox } from "../delivery/outbox.ts";
import { pacingDelay } from "../delivery/pacing.ts";
import { shapeParts } from "../delivery/shape.ts";
import { createSplitter } from "../delivery/split.ts";
import { errorText } from "../log.ts";
import { createDeliverer } from "./deliver.ts";
import { generate } from "./generate.ts";

type Outcome =
  | "completed"
  | "skipped"
  | "superseded"
  | "failed"
  | "timed-out"
  | "interrupted";

export interface TurnResult {
  outcome: Outcome;
  reason?: string;
  sent: number;
  undelivered: string[];
  uncertain?: boolean;
}

interface ReplyRequest {
  conversation: Conversation;
  channel: Channel;
  turn: string;
  model: LanguageModel;
  instructions: string;
  messages: ModelMessage[];
  tools: ToolSet;
  maxSteps: number;
  delivery: DeliverySettings;
  signal: AbortSignal;
  record: (entry: EntryInput) => Promise<void>;
}

interface ReplyResult {
  sent: number;
  undelivered: string[];
  error?: unknown;
  finishReason?: string;
  stoppedBy?: Delivery;
}

function partText(part: OutgoingPart) {
  return "text" in part ? part.text : part.videoUrl;
}

export function stopReason(signal: AbortSignal) {
  return signal.reason instanceof TurnStop ? signal.reason.reason : undefined;
}

function createPipeline(request: ReplyRequest, generation: AbortController) {
  const { conversation, channel, delivery } = request;
  const deliver = createDeliverer(conversation, channel, request.turn);
  const state: { stoppedBy?: Delivery } = {};
  const outbox = createOutbox({
    deliver: async (part) => {
      const result = await deliver(part);
      if (result === "sent") return "sent";
      state.stoppedBy = result;
      generation.abort(new Error("Delivery stopped."));
      return "stop";
    },
    delayFor: pacingDelay(delivery),
    beforeDelay: () =>
      void channel.typing?.(conversation.chat).catch(() => undefined),
    signal: request.signal,
  });
  const splitter = createSplitter(delivery.boundary);
  const held: string[] = [];
  const send = (pieces: string[]) =>
    pieces.forEach((piece) =>
      outbox.push(...shapeParts(piece, delivery, channel)),
    );
  const emit = (pieces: string[]) =>
    delivery.timing === "stream" ? send(pieces) : held.push(...pieces);
  return {
    onText: (text: string) => emit(splitter.push(text)),
    onStepEnd: () => emit(splitter.flush()),
    finish: () => send([...held.splice(0), ...splitter.flush()]),
    async close() {
      outbox.close();
      const { sent, undelivered } = await outbox.done;
      const leftover = [...held, ...splitter.flush()];
      return {
        sent,
        undelivered: [...undelivered.map(partText), ...leftover],
        stoppedBy: state.stoppedBy,
      };
    },
  };
}

export async function reply(request: ReplyRequest): Promise<ReplyResult> {
  const generation = new AbortController();
  const pipeline = createPipeline(request, generation);
  const signal = AbortSignal.any([request.signal, generation.signal]);
  try {
    const finishReason = await generate({
      ...request,
      signal,
      onText: pipeline.onText,
      onStepEnd: pipeline.onStepEnd,
    });
    pipeline.finish();
    return { ...(await pipeline.close()), finishReason };
  } catch (error) {
    return { ...(await pipeline.close()), error };
  }
}

function failure(result: ReplyResult) {
  if (result.stoppedBy === "uncertain")
    return { reason: "Delivery is uncertain.", uncertain: true };
  if (result.stoppedBy) return { reason: "Delivery failed." };
  if (result.error) return { reason: errorText(result.error) };
  if (result.finishReason === "tool-calls")
    return { reason: "The work limit was reached." };
  return undefined;
}

export function classify(
  result: ReplyResult,
  signal: AbortSignal,
  limit: AbortSignal,
): TurnResult {
  const base = { sent: result.sent, undelivered: result.undelivered };
  const stop = stopReason(signal);
  if (stop === "shutdown")
    return {
      ...base,
      outcome: "interrupted",
      reason: "The harness shut down.",
    };
  if (stop)
    return {
      ...base,
      outcome: result.sent > 0 ? "interrupted" : "superseded",
      reason: "New customer input arrived.",
    };
  if (limit.aborted)
    return {
      ...base,
      outcome: "timed-out",
      reason: "The maximum response time was reached.",
    };
  const failed = failure(result);
  if (failed) return { ...base, outcome: "failed", ...failed };
  if (result.sent === 0)
    return {
      ...base,
      outcome: "skipped",
      reason: "The agent chose not to reply.",
    };
  return { ...base, outcome: "completed" };
}
