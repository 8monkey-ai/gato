import type { ChannelConnection } from "../channels/channel.ts";
import type { Controls } from "../conversation/controls.ts";
import { mayAnswer } from "../conversation/ownership.ts";
import type { Logger } from "../log.ts";
import type {
  ChatRef,
  EntryBody,
  TurnEnd,
  TurnTrigger,
} from "../record/types.ts";
import { skillCatalogue } from "../skills/catalogue.ts";
import type { Revision } from "../skills/loader.ts";
import type { ContextDeps } from "./turn-context.ts";
import { type End, errorEnd } from "./turn-outcome.ts";

export type Turn = {
  deps: ContextDeps & { controls: Controls };
  ref: ChatRef;
  trigger: TurnTrigger;
  signal: AbortSignal;
  turnId: string;
  connection: ChannelConnection;
  log: Logger;
  started: boolean;
};

export type Work = { end: End; sentParts: number };

export const isNudge = (trigger: TurnTrigger) =>
  trigger === "nudge" || trigger === "nudge-retry";

export const append = (turn: Turn, bodies: EntryBody[]) =>
  turn.deps.store.append(turn.ref, bodies);

const revisionRecord = (revision: Revision) =>
  `${revision.instructions.trim()}\n\n# Skills\n\n${skillCatalogue(revision)}\n`;

// Appends turn-start with the bodies that belong to it, and keeps the instructions the turn uses.
export async function startTurn(
  turn: Turn,
  revision: Revision | undefined,
  more: EntryBody[] = [],
) {
  const view = await turn.deps.store.load(turn.ref);
  const start = {
    type: "turn-start",
    turnId: turn.turnId,
    trigger: turn.trigger,
    inputThroughSeq: view.lastSeq,
    instructionsRevision: revision?.id ?? "unavailable",
  } satisfies EntryBody;
  if (revision)
    await turn.deps.store.saveInstructions(
      turn.ref,
      revision.id,
      revisionRecord(revision),
    );
  const started = await append(turn, [start, ...more]);
  turn.started = true;
  turn.log.info("turn.start", {
    trigger: start.trigger,
    inputThroughSeq: start.inputThroughSeq,
    instructionsRevision: start.instructionsRevision,
  });
  return started;
}

async function errorHandoff(turn: Turn, end: End) {
  const { deps, ref, turnId } = turn;
  try {
    const state = await deps.controls.state(ref);
    if (!mayAnswer(state, deps.settings.ownershipPolicy)) return;
    const reason = `The agent could not answer (${end.outcome}): ${end.reason ?? "no reason recorded"}`;
    await deps.controls.handoff(ref, { path: "error", reason, turnId });
  } catch (error) {
    turn.log.error("turn.error_handoff_failed", { error });
  }
}

export async function finish(
  turn: Turn,
  { end, sentParts }: Work,
): Promise<TurnEnd> {
  const { outcome, reason } = end;
  await append(turn, [
    {
      type: "turn-end",
      turnId: turn.turnId,
      outcome,
      ...(reason ? { reason } : {}),
    },
  ]);
  turn.log.info("turn.end", { outcome, reason, sentParts });
  const failed = outcome === "failed" || outcome === "timed-out";
  if (failed && sentParts === 0 && !isNudge(turn.trigger))
    await errorHandoff(turn, end);
  return outcome;
}

// Ends a turn after an unexpected error, so that every started turn has a turn-end.
export async function failTurn(
  turn: Turn,
  revision: Revision | undefined,
  error: unknown,
) {
  if (!turn.started) await startTurn(turn, revision);
  const view = await turn.deps.store.load(turn.ref);
  const sentParts = view.messages.filter(
    (m) => m.turnId === turn.turnId && m.delivery === "sent",
  ).length;
  return finish(turn, { end: errorEnd(error), sentParts });
}
