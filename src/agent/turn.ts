import type { Connection } from "../channels/channel.ts";
import { createDelivery } from "../delivery/deliver.ts";
import { log, redact } from "../log.ts";
import type { Outcome, Trigger } from "../record/chat-file.ts";
import type { Conversation } from "../record/store.ts";
import { type AgentDeps, generate, type Turn } from "./generate.ts";
import { createBudget } from "./models.ts";

type Stopped = "failed" | "uncertain" | undefined;
type Result = { outcome: Outcome; detail?: string; stopped: Stopped };

export function createTurnRunner(deps: AgentDeps) {
  return async (
    conversation: Conversation,
    connection: Connection,
    trigger: Trigger,
    interruption: AbortSignal,
  ) => {
    const started = new Date();
    const id = crypto.randomUUID().slice(0, 8);
    const where = {
      connection: connection.id,
      contact: conversation.contact,
      turn: id,
      trigger,
    };
    if (!(await isAgentOwned(connection, conversation.contact, where))) return;
    log.info("turn.started", where);
    const budget = createBudget(deps.config.turn, interruption);
    const delivery = createDelivery({
      conversation,
      connection,
      turn: id,
      msPerWord: deps.config.delivery.msPerWord,
      startedAt: started.getTime(),
      signal: budget.signal,
    });
    const turn = { id, conversation, connection, trigger, budget, delivery };
    const result = await execute(deps, turn, interruption);
    await finish(turn, started, result, where);
  };
}

async function isAgentOwned(
  connection: Connection,
  contact: string,
  where: Record<string, string>,
) {
  try {
    const owned = await connection.isAgentOwned(contact);
    if (!owned) log.info("turn.not_agent_owned", where);
    return owned;
  } catch (error) {
    log.error("turn.ownership_unknown", { ...where, error });
    return false;
  }
}

async function execute(
  deps: AgentDeps,
  turn: Turn,
  interruption: AbortSignal,
): Promise<Result> {
  let generated = false;
  let failure: unknown;
  try {
    generated = await generate(deps, turn);
  } catch (error) {
    failure = error;
  }
  const { delivered, stopped } = await turn.delivery.finish();
  const outcome: Outcome = interruption.aborted
    ? delivered
      ? "interrupted"
      : "superseded"
    : decideEnd(turn, failure, stopped, generated);
  const reason = explain(outcome, failure, stopped);
  const nudgeFailed = turn.trigger === "nudge" && isFailure(outcome);
  const detail = nudgeFailed ? `Nudge failed: ${reason}` : reason;
  return { outcome, detail, stopped };
}

function decideEnd(
  turn: Turn,
  failure: unknown,
  stopped: Stopped,
  generated: boolean,
): Outcome {
  if (turn.budget.timedOut()) return "timed-out";
  if (failure || stopped) return "failed";
  return generated ? "completed" : "skipped";
}

const isFailure = (outcome: Outcome) =>
  outcome === "failed" || outcome === "timed-out";

function explain(outcome: Outcome, failure: unknown, stopped: Stopped) {
  if (outcome === "skipped") return "The agent wrote no reply.";
  if (outcome === "timed-out") return "The turn reached its time limit.";
  if (stopped) {
    const how = stopped === "uncertain" ? "uncertain" : "refused";
    return `Delivery stopped because a send was ${how}.`;
  }
  if (!failure) return undefined;
  return redact(
    failure instanceof Error ? failure.message : JSON.stringify(failure),
  );
}

async function finish(
  turn: Turn,
  started: Date,
  { outcome, detail, stopped }: Result,
  where: Record<string, string>,
) {
  const level = isFailure(outcome) ? "error" : "info";
  log[level]("turn.ended", { ...where, outcome, detail });
  await turn.conversation.lock(async (edit) => {
    edit.add({
      kind: "turn",
      at: new Date().toISOString(),
      turn: turn.id,
      trigger: turn.trigger,
      outcome,
      started: started.toISOString(),
      text: detail,
    });
    await edit.save();
  });
  if (turn.trigger !== "customer" || !isFailure(outcome)) return;
  if (stopped === "uncertain" || !turn.connection.handoff) return;
  await turn.connection
    .handoff(turn.conversation.contact, detail ?? outcome, "error")
    .catch((error: unknown) =>
      log.error("handoff.failed", { ...where, error }),
    );
}
