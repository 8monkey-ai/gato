import type { LanguageModel, ModelMessage, ToolSet } from "ai";

import type { Channel } from "../channels/channel.ts";
import type { Settings } from "../config/settings.ts";
import type { EntryInput } from "../conversation/entry.ts";
import { addNote } from "../conversation/notes.ts";
import { awaitsReply, insertEntry } from "../conversation/record.ts";
import type { Conversation } from "../conversation/store.ts";
import { logFields, save } from "../conversation/store.ts";
import type { TurnKind, TurnRunner } from "../conversation/turns.ts";
import { log } from "../log.ts";
import type { TurnResult } from "./reply.ts";
import { classify, reply, stopReason } from "./reply.ts";

export interface Budget {
  steps: number;
  signal: AbortSignal;
}

export interface TurnContext {
  instructions: string;
  messages: ModelMessage[];
  tools: ToolSet;
}

interface RunnerDeps {
  settings: Settings;
  channelOf(conversation: Conversation): Channel;
  model: LanguageModel;
  prepare(
    conversation: Conversation,
    turn: string,
    budget: Budget,
  ): Promise<TurnContext>;
  afterTurn(
    conversation: Conversation,
    kind: TurnKind,
    result: TurnResult,
    turn: string,
  ): Promise<void>;
}

function recorder(conversation: Conversation, turn: string) {
  return async (entry: EntryInput) => {
    if (entry.kind === "tool-call") {
      log("info", "tool.called", {
        ...logFields(conversation),
        turn,
        tool: entry.tool,
      });
    }
    insertEntry(conversation.entries, {
      ...entry,
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      turn,
    });
    await save(conversation);
  };
}

async function attempt(
  deps: RunnerDeps,
  conversation: Conversation,
  kind: TurnKind,
  turn: string,
  signal: AbortSignal,
) {
  if (kind === "review" && !awaitsReply(conversation.entries)) {
    return {
      outcome: "skipped",
      reason: "No customer request awaits an answer.",
      sent: 0,
      undelivered: [],
    } as TurnResult;
  }
  const limit = AbortSignal.timeout(deps.settings.limits.maxDurationMs);
  const combined = AbortSignal.any([signal, limit]);
  const record = recorder(conversation, turn);
  if (kind === "nudge")
    await record({ kind: "trigger", text: deps.settings.nudges.instruction });
  try {
    const budget = { steps: deps.settings.limits.maxSteps, signal: combined };
    const context = await deps.prepare(conversation, turn, budget);
    if (budget.steps <= 0)
      throw new Error("The work limit was reached before the reply.");
    const result = await reply({
      ...context,
      conversation,
      channel: deps.channelOf(conversation),
      turn,
      model: deps.model,
      maxSteps: budget.steps,
      delivery: deps.settings.delivery,
      signal: combined,
      record,
    });
    return classify(result, signal, limit);
  } catch (error) {
    return classify({ sent: 0, error, undelivered: [] }, signal, limit);
  }
}

export function createTurnRunner(deps: RunnerDeps): TurnRunner {
  return async (conversation, kind, signal) => {
    const turn = crypto.randomUUID();
    const fields = { ...logFields(conversation), turn, kind };
    log("info", "turn.started", fields);
    conversation.state.pendingReply = false;
    conversation.state.activeTurn = turn;
    await save(conversation);
    const result = await attempt(deps, conversation, kind, turn, signal);
    const channel = deps.channelOf(conversation);
    if (result.undelivered.length > 0) {
      await addNote(conversation, channel, {
        type: "draft",
        text: result.undelivered.join("\n\n"),
        turn,
      });
    }
    const reason = result.reason ? `: ${result.reason}` : "";
    await addNote(conversation, channel, {
      type: "outcome",
      text: `Turn ${result.outcome}${reason}`,
      turn,
    });
    conversation.state.activeTurn = undefined;
    if (
      stopReason(signal) === "shutdown" &&
      result.sent === 0 &&
      kind !== "nudge"
    )
      conversation.state.pendingReply = true;
    await save(conversation);
    log(
      result.outcome === "failed" || result.outcome === "timed-out"
        ? "warn"
        : "info",
      `turn.${result.outcome}`,
      {
        ...fields,
        reason: result.reason,
      },
    );
    await deps.afterTurn(conversation, kind, result, turn);
  };
}
