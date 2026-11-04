import type { Logger } from "../log.ts";
import type { ChatView } from "../record/projection.ts";
import type { ChatRef, TurnEnd, TurnTrigger } from "../record/types.ts";
import { isVisibleMessage } from "../record/visibility.ts";
import { chatKey } from "../storage/chat-files.ts";
import type { ChatStore, NewEntry } from "../storage/chat-store.ts";
import type { Controls } from "./controls.ts";
import {
  type ChatState,
  mayAnswer,
  type OwnershipPolicy,
} from "./ownership.ts";

type Run = {
  controller: AbortController;
  done: Promise<TurnEnd>;
  queued?: TurnTrigger;
  // Set by abort: the chat is obsolete, so no queued turn follows.
  final?: boolean;
};

const latestVisibleIsCustomer = (view: ChatView) =>
  view.messages.filter(isVisibleMessage).at(-1)?.author.role === "customer";

function recoveryEntries(view: ChatView): NewEntry[] {
  return [
    ...view.turns
      .filter((turn) => !turn.end)
      .map((turn): NewEntry => ({
        type: "turn-end",
        turnId: turn.turnId,
        outcome: "interrupted",
        reason: "abandoned at restart",
      })),
    ...view.messages
      .filter((m) => m.author.role === "agent" && m.delivery === "pending")
      .map((m): NewEntry => ({
        type: "message-update",
        messageId: m.id,
        delivery: "uncertain",
      })),
  ];
}

type Context = {
  store: ChatStore;
  controls: Pick<Controls, "state" | "note">;
  policy: OwnershipPolicy;
  // Resolves false when the native state of the chat could not be fetched.
  reconcile: (ref: ChatRef) => Promise<boolean>;
  runTurn: (
    ref: ChatRef,
    trigger: TurnTrigger,
    signal: AbortSignal,
  ) => Promise<TurnEnd>;
  log: Logger;
};
type Scheduler = Context & { runs: Map<string, Run>; stopping: boolean };
type Start = {
  trigger: TurnTrigger;
  // Replies fall back to the recorded state when the native state is unavailable; nudges do not.
  needsReconciled: boolean;
  beforeRun?: () => unknown;
};

async function admitted(
  s: Scheduler,
  ref: ChatRef,
  { trigger, needsReconciled }: Start,
) {
  try {
    if (!(await s.reconcile(ref)) && needsReconciled) return false;
    const state = await s.controls.state(ref);
    if (s.store.isDamaged(ref) || !mayAnswer(state, s.policy)) return false;
    if (trigger !== "review" || latestVisibleIsCustomer(state.view))
      return true;
    await s.controls.note(ref, {
      by: "system",
      kind: "skip",
      text: "No customer request awaits an answer",
    });
    return false;
  } catch (error) {
    s.log.error("scheduler.state_failed", { ...ref, trigger, error });
    return false;
  }
}

async function execute(
  s: Scheduler,
  ref: ChatRef,
  start: Start,
  run: Run,
): Promise<TurnEnd> {
  const { trigger, beforeRun } = start;
  if (!(await admitted(s, ref, start))) return "skipped";
  const { signal } = run.controller;
  if (signal.aborted)
    return signal.reason === "interrupted" ? "superseded" : "interrupted";
  try {
    await beforeRun?.();
    return await s.runTurn(ref, trigger, signal);
  } catch (error) {
    s.log.error("scheduler.turn_failed", { ...ref, trigger, error });
    return "failed";
  }
}

function launch(s: Scheduler, ref: ChatRef, start: Start) {
  const run: Run = {
    controller: new AbortController(),
    done: Promise.resolve("skipped"),
  };
  s.runs.set(chatKey(ref), run);
  run.done = execute(s, ref, start, run).finally(() => {
    s.runs.delete(chatKey(ref));
    if (run.queued && !run.final) startEligible(s, ref, run.queued);
  });
  return run.done;
}

function startEligible(s: Scheduler, ref: ChatRef, trigger: TurnTrigger) {
  if (!s.stopping) void launch(s, ref, { trigger, needsReconciled: false });
}

function customerMessage(s: Scheduler, ref: ChatRef) {
  const run = s.runs.get(chatKey(ref));
  if (!run) return startEligible(s, ref, "customer");
  run.queued = "customer";
  run.controller.abort("interrupted");
}

// Gaining eligibility (assignment back to the agent, reopening, resuming) asks for a review.
function stateChanged(
  s: Scheduler,
  ref: ChatRef,
  previous: ChatState,
  current: ChatState,
) {
  if (mayAnswer(previous, s.policy) || !mayAnswer(current, s.policy)) return;
  const run = s.runs.get(chatKey(ref));
  if (run) run.queued ??= "review";
  else startEligible(s, ref, "review");
}

function runExclusive(s: Scheduler, ref: ChatRef, start: Start) {
  if (s.stopping || s.runs.has(chatKey(ref)))
    return Promise.resolve("busy" as const);
  return launch(s, ref, start);
}

async function abort(s: Scheduler, ref: ChatRef, reason: string) {
  const run = s.runs.get(chatKey(ref));
  if (!run) return;
  run.final = true;
  run.controller.abort(reason);
  await run.done;
}

async function recover(s: Scheduler) {
  for (const ref of s.store.list()) {
    if (s.store.isDamaged(ref)) continue;
    try {
      const view = await s.store.withChat(ref, (session) =>
        session.append(recoveryEntries(session.view())),
      );
      if (view.hasPendingInput && !s.runs.has(chatKey(ref)))
        startEligible(s, ref, "customer");
    } catch (error) {
      s.log.error("scheduler.recover_failed", { ...ref, error });
    }
  }
}

async function stop(s: Scheduler, graceMs: number) {
  s.stopping = true;
  const settled = () => Promise.all([...s.runs.values()].map((r) => r.done));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise((resolve) => {
    timer = setTimeout(resolve, graceMs);
  });
  await Promise.race([settled(), grace]);
  clearTimeout(timer);
  for (const run of s.runs.values()) run.controller.abort("shutdown");
  await settled();
}

export function createScheduler(ctx: Context) {
  const s: Scheduler = { ...ctx, runs: new Map(), stopping: false };
  return {
    customerMessage: (ref: ChatRef) => customerMessage(s, ref),
    stateChanged: (ref: ChatRef, previous: ChatState, current: ChatState) =>
      stateChanged(s, ref, previous, current),
    // beforeRun runs once the chat is admitted, right before the turn.
    runExclusive: (
      ref: ChatRef,
      trigger: TurnTrigger,
      options: { beforeRun?: () => unknown } = {},
    ): Promise<TurnEnd | "busy"> =>
      runExclusive(s, ref, { trigger, needsReconciled: true, ...options }),
    abort: (ref: ChatRef, reason: string) => abort(s, ref, reason),
    recover: () => recover(s),
    stop: (graceMs: number) => stop(s, graceMs),
    busy: (ref: ChatRef) => s.runs.has(chatKey(ref)),
  };
}
