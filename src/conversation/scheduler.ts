import type { Logger } from "../log.ts";
import type { ChatView } from "../record/projection.ts";
import type { ChatRef, Owner, TurnTrigger } from "../record/types.ts";
import { folderName } from "../storage/chat-files.ts";
import type { ChatStore, NewEntry } from "../storage/chat-store.ts";
import type { Controls } from "./controls.ts";
import { agentMayAnswer, type OwnershipPolicy } from "./ownership.ts";

type Run = {
  controller: AbortController;
  done: Promise<boolean>;
  queued?: TurnTrigger;
};

const keyOf = (ref: ChatRef) => `${ref.connectionId}/${folderName(ref.chatId)}`;

function latestVisibleIsCustomer(view: ChatView) {
  const visible = view.messages.filter(
    (m) =>
      m.author.role !== "agent" ||
      m.delivery === "observed" ||
      m.delivery === "sent",
  );
  return visible.at(-1)?.author.role === "customer";
}

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
  runTurn: (
    ref: ChatRef,
    trigger: TurnTrigger,
    signal: AbortSignal,
  ) => Promise<void>;
  log: Logger;
};
type Scheduler = Context & { runs: Map<string, Run>; stopping: boolean };

const isDamaged = ({ store }: Scheduler, ref: ChatRef) =>
  store.damaged().some((d) => keyOf(d.ref) === keyOf(ref));

async function admitted(s: Scheduler, ref: ChatRef, trigger: TurnTrigger) {
  try {
    const { owner, open, view } = await s.controls.state(ref);
    if (isDamaged(s, ref) || !open || !agentMayAnswer(owner, s.policy))
      return false;
    if (trigger !== "review" || latestVisibleIsCustomer(view)) return true;
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
  trigger: TurnTrigger,
  run: Run,
  admit: () => Promise<boolean>,
) {
  if (!(await admit()) || run.controller.signal.aborted) return false;
  try {
    await s.runTurn(ref, trigger, run.controller.signal);
  } catch (error) {
    s.log.error("scheduler.turn_failed", { ...ref, trigger, error });
  }
  return true;
}

function launch(
  s: Scheduler,
  ref: ChatRef,
  trigger: TurnTrigger,
  admit: () => Promise<boolean>,
) {
  const run: Run = {
    controller: new AbortController(),
    done: Promise.resolve(false),
  };
  s.runs.set(keyOf(ref), run);
  run.done = execute(s, ref, trigger, run, admit).finally(() => {
    s.runs.delete(keyOf(ref));
    if (run.queued) startEligible(s, ref, run.queued);
  });
  return run.done;
}

function startEligible(s: Scheduler, ref: ChatRef, trigger: TurnTrigger) {
  if (!s.stopping)
    void launch(s, ref, trigger, () => admitted(s, ref, trigger));
}

function customerMessage(s: Scheduler, ref: ChatRef) {
  const run = s.runs.get(keyOf(ref));
  if (!run) return startEligible(s, ref, "customer");
  run.queued = "customer";
  run.controller.abort("interrupted");
}

function ownershipChange(
  s: Scheduler,
  ref: ChatRef,
  previous: Owner,
  owner: Owner,
) {
  if (agentMayAnswer(previous, s.policy) || !agentMayAnswer(owner, s.policy))
    return;
  const run = s.runs.get(keyOf(ref));
  if (run) run.queued ??= "review";
  else startEligible(s, ref, "review");
}

async function recover(s: Scheduler) {
  for (const ref of s.store.list()) {
    if (isDamaged(s, ref)) continue;
    try {
      const view = await s.store.withChat(ref, (session) =>
        session.append(recoveryEntries(session.view())),
      );
      if (view.hasPendingInput && !s.runs.has(keyOf(ref)))
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
    ownershipChange: (ref: ChatRef, previous: Owner, owner: Owner) =>
      ownershipChange(s, ref, previous, owner),
    runExclusive: (ref: ChatRef, trigger: TurnTrigger) =>
      s.stopping || s.runs.has(keyOf(ref))
        ? Promise.resolve(false)
        : launch(s, ref, trigger, () => Promise.resolve(true)),
    recover: () => recover(s),
    stop: (graceMs: number) => stop(s, graceMs),
    busy: (ref: ChatRef) => s.runs.has(keyOf(ref)),
  };
}
