import { Budget, WorkLimitError } from "../agent/models.ts";
import type { Channel } from "../channels/channel.ts";
import {
  Delivery,
  type DeliveryOutcome,
  type DeliveryPolicy,
} from "../delivery/deliver.ts";
import { errorText, log } from "../log.ts";
import type { TurnEntry, TurnStatus } from "../record/entries.ts";
import type { Chat } from "../record/store.ts";
import { addNote, handOffAfterError } from "./notes.ts";
import { generateReply, type ReplyDeps } from "./reply.ts";

export interface TurnDeps extends ReplyDeps {
  delivery: DeliveryPolicy;
  timeoutMs: number;
}

interface TurnJob {
  chat: Chat;
  channel: Channel;
  trigger: TurnEntry["trigger"];
  covers: string[];
  /** Fires when new customer input or shutdown stops the turn. */
  interrupt: AbortSignal;
}

interface Outcome {
  status: TurnStatus;
  reason?: string;
}

function failureOutcome(
  error: unknown,
  job: TurnJob,
  timeout: AbortSignal,
  delivered: number,
): Outcome {
  if (job.interrupt.aborted)
    return {
      status: delivered ? "interrupted" : "superseded",
      reason: String(job.interrupt.reason),
    };
  if (timeout.aborted)
    return { status: "timed-out", reason: "the turn reached its time limit" };
  if (error instanceof WorkLimitError)
    return { status: "failed", reason: error.message };
  return { status: "failed", reason: `the turn failed: ${errorText(error)}` };
}

function successOutcome(
  skipped: string | undefined,
  delivery: DeliveryOutcome,
): Outcome {
  if (delivery.failure === "uncertain")
    return {
      status: "failed",
      reason: "a send has an uncertain outcome; nothing is sent again",
    };
  if (delivery.failure === "failed")
    return { status: "failed", reason: "a send failed" };
  if (skipped !== undefined)
    return { status: "skipped", reason: skipped || "no reason given" };
  if (!delivery.delivered)
    return { status: "skipped", reason: "the agent gave no text" };
  return { status: "completed" };
}

async function afterTurn(
  job: TurnJob,
  turn: TurnEntry,
  outcome: Outcome,
  delivery: DeliveryOutcome,
) {
  const { chat, channel } = job;
  const failed = outcome.status === "failed" || outcome.status === "timed-out";
  if (outcome.status === "skipped")
    await addNote(chat, channel, {
      author: "agent",
      kind: "skip",
      text: outcome.reason ?? "",
      turn: turn.id,
    });
  else if (failed && job.trigger === "nudge")
    await addNote(chat, channel, {
      author: "harness",
      kind: "nudge-failed",
      text: `Nudge failed: ${outcome.reason}`,
      turn: turn.id,
    });
  else if (failed && delivery.failure !== "uncertain")
    await handOffAfterError(
      chat,
      channel,
      turn.id,
      outcome.reason ?? "unknown error",
    );
}

async function attempt(deps: TurnDeps, job: TurnJob, turn: TurnEntry) {
  const timeout = AbortSignal.timeout(deps.timeoutMs);
  const signal = AbortSignal.any([job.interrupt, timeout]);
  const delivery = new Delivery(
    job.channel,
    job.chat,
    turn.id,
    deps.delivery,
    signal,
  );
  try {
    const reply = await generateReply(deps, {
      chat: job.chat,
      channel: job.channel,
      turn: turn.id,
      nudge: job.trigger === "nudge",
      budget: new Budget(deps.settings.maxModelCalls),
      signal,
      delivery,
    });
    const delivered = await delivery.finish();
    const outcome = signal.aborted
      ? failureOutcome(signal.reason, job, timeout, delivered.delivered)
      : successOutcome(reply.skipped, delivered);
    return { outcome, delivered };
  } catch (error) {
    const delivered = await delivery.finish();
    const outcome = failureOutcome(error, job, timeout, delivered.delivered);
    return { outcome, delivered };
  }
}

/** Runs one agent turn and records its outcome. Never throws for turn failures. */
export async function runTurn(
  deps: TurnDeps,
  job: TurnJob,
): Promise<TurnStatus> {
  const { chat, channel } = job;
  const turn: TurnEntry = await chat.add({
    type: "turn",
    at: new Date().toISOString(),
    trigger: job.trigger,
    status: "running",
    covers: job.covers,
  });
  log.info("turn.started", {
    conversation: chat.id,
    channel: channel.name,
    turn: turn.id,
    trigger: job.trigger,
  });
  const { outcome, delivered } = await attempt(deps, job, turn);
  await chat.update(turn, {
    ...outcome,
    endedAt: new Date().toISOString(),
    ...(delivered.unsent.length && { unsent: delivered.unsent.join("\n\n") }),
  });
  log.info("turn.ended", {
    conversation: chat.id,
    turn: turn.id,
    status: outcome.status,
    delivered: delivered.delivered,
  });
  await afterTurn(job, turn, outcome, delivered);
  return outcome.status;
}
