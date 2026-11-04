import type { ChannelConnection } from "../channels/channel.ts";
import type { Settings } from "../config/settings.ts";
import type { Controls } from "../conversation/controls.ts";
import {
  type ChatState,
  mayAnswer,
  sameState,
} from "../conversation/ownership.ts";
import type { createReconciler } from "../conversation/reconcile.ts";
import type { createScheduler } from "../conversation/scheduler.ts";
import type { Logger } from "../log.ts";
import type { ChatView } from "../record/projection.ts";
import type { ChatRef } from "../record/types.ts";
import { isVisibleMessage } from "../record/visibility.ts";
import { chatKey } from "../storage/chat-files.ts";
import type { ChatStore } from "../storage/chat-store.ts";
import { healthyChats } from "./chats.ts";
import { createLimit } from "./limit.ts";
import { recordNudgeOutcome } from "./outcome.ts";
import { expiredAt, selectAction, withinHours } from "./policy.ts";

type Deps = {
  store: ChatStore;
  controls: Pick<Controls, "state" | "note" | "handoff" | "readLabels">;
  scheduler: Pick<
    ReturnType<typeof createScheduler>,
    "busy" | "runExclusive" | "stateChanged"
  >;
  reconciler: ReturnType<typeof createReconciler>;
  connection: (connectionId: string) => ChannelConnection;
  // A chat folder can outlive the configuration of its connection.
  hasConnection: (connectionId: string) => boolean;
  settings: Pick<Settings, "nudges" | "ownershipPolicy" | "timeZone">;
  log: Logger;
  now: () => Date;
};
type State = Awaited<ReturnType<Controls["state"]>>;
type LabelState = "present" | "absent" | "unknown";
type Check = {
  stopped: () => boolean;
  // The last state seen per chat without native assignment, to notice when an operator resumes it.
  localStates: Map<string, ChatState>;
  limit: ReturnType<typeof createLimit>;
};

function agentActivity(view: ChatView) {
  const messages = view.messages
    .filter((m) => m.author.role === "agent" && isVisibleMessage(m))
    .map((m) => m.sentAt);
  const notes = view.notes.filter((n) => n.by === "agent").map((n) => n.at);
  return [...messages, ...notes].map((at) => new Date(at));
}

async function exemptLabelState(d: Deps, ref: ChatRef): Promise<LabelState> {
  try {
    const labels = await d.controls.readLabels(ref);
    return labels.includes(d.settings.nudges.expiryExemptLabel)
      ? "present"
      : "absent";
  } catch (error) {
    d.log.warn("expiry.exemption_labels_unavailable", { ...ref, error });
    return "unknown";
  }
}

async function nudgeInput(
  view: ChatView,
  d: Deps,
  exemptLabels: () => Promise<LabelState>,
) {
  const latest = view.latestCustomerAt;
  if (latest === undefined || expiredAt(view) !== undefined) return undefined;
  const latestCustomerAt = new Date(latest);
  const now = d.now();
  const { nudges, timeZone } = d.settings;
  const expiryDue =
    nudges.expiryEnabled &&
    now.getTime() - latestCustomerAt.getTime() >= nudges.expiryAfterMs;
  return {
    now,
    latestCustomerAt,
    agentActivity: agentActivity(view),
    milestonesMs: nudges.milestonesMs,
    expiryAfterMs: nudges.expiryAfterMs,
    nudgesEnabled: nudges.enabled,
    expiryEnabled: nudges.expiryEnabled,
    // The policy ignores the label state before the threshold, so read labels only when expiry is due.
    exemptLabelState: expiryDue ? await exemptLabels() : ("unknown" as const),
    withinPermittedHours: withinHours(now, nudges.hours, timeZone),
  };
}

async function dueAction(
  d: Deps,
  ref: ChatRef,
  state: State,
  exemptLabels: () => Promise<LabelState>,
) {
  if (!mayAnswer(state, d.settings.ownershipPolicy) || d.scheduler.busy(ref))
    return undefined;
  const input = await nudgeInput(state.view, d, exemptLabels);
  const action = input && selectAction(input);
  return action?.kind === "none" ? undefined : action;
}

async function expire(d: Deps, ref: ChatRef, elapsedMs: number) {
  const minutes = Math.floor(elapsedMs / 60_000);
  const reason = `Expired: no customer reply for ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  await d.controls.note(ref, { by: "system", kind: "expiry", text: reason });
  await d.controls.handoff(ref, { path: "expiry", reason });
}

async function nudge(d: Deps, ref: ChatRef) {
  const outcome = await d.scheduler.runExclusive(ref, "nudge", {
    beforeRun: () =>
      d.controls.note(ref, { by: "agent", kind: "nudge", text: "Nudge" }),
  });
  await recordNudgeOutcome(d.controls, ref, outcome);
}

// Decides again inside the action slot, because the chat can change while it waits for one.
async function act(d: Deps, check: Check, ref: ChatRef) {
  if (check.stopped()) return;
  const state = await d.controls.state(ref);
  const action = await dueAction(d, ref, state, () => exemptLabelState(d, ref));
  if (!action || check.stopped()) return;
  if (action.kind === "expire") await expire(d, ref, action.elapsedMs);
  if (action.kind === "nudge") await nudge(d, ref);
}

function noticeLocalChange(d: Deps, check: Check, ref: ChatRef, state: State) {
  if (d.connection(ref.connectionId).assignment) return;
  const previous = check.localStates.get(chatKey(ref));
  const { owner, open, paused } = state;
  check.localStates.set(chatKey(ref), { owner, open, paused });
  if (previous && !sameState(previous, state))
    d.scheduler.stateChanged(ref, previous, state);
}

const reconciled = (d: Deps, check: Check, ref: ChatRef) =>
  d.reconciler.isReconciled(ref) ||
  check.limit(async () =>
    check.stopped()
      ? false
      : d.reconciler.reconcile(ref, (previous, current) =>
          d.scheduler.stateChanged(ref, previous, current),
        ),
  );

async function checkChat(d: Deps, check: Check, ref: ChatRef) {
  if (!(await reconciled(d, check, ref))) return;
  const state = await d.controls.state(ref);
  noticeLocalChange(d, check, ref, state);
  // Labels are read only in the slot; assuming no exemption here only lets a chat into the slot.
  const absent = () => Promise.resolve<LabelState>("absent");
  if (await dueAction(d, ref, state, absent))
    await check.limit(() => act(d, check, ref));
}

const checkAll = (d: Deps, check: Check) =>
  Promise.all(
    healthyChats(d.store).map((ref) =>
      checkChat(d, check, ref).catch((error: unknown) =>
        d.log.error("nudge.check_failed", { ...ref, error }),
      ),
    ),
  );

function readiness(d: Deps, lastCheckAt: string | undefined) {
  const all = healthyChats(d.store);
  const refs = all.filter((ref) => d.hasConnection(ref.connectionId));
  const reconciledChats = refs.filter(d.reconciler.isReconciled).length;
  return {
    reconciledChats,
    unreconciledChats: refs.length - reconciledChats,
    unconfiguredChats: all.length - refs.length,
    lastCheckAt,
  };
}

export function createNudgeChecker(d: Deps) {
  let running: Promise<void> | undefined;
  let stopped = false;
  let lastCheckAt: string | undefined;
  let timers: ReturnType<typeof setTimeout>[] = [];
  const check: Check = {
    stopped: () => stopped,
    localStates: new Map(),
    limit: createLimit(d.settings.nudges.concurrency),
  };
  const runCheck = async () => {
    await checkAll(d, check);
    lastCheckAt = d.now().toISOString();
  };
  const checkOnce = () => {
    if (stopped) return Promise.resolve();
    running ??= runCheck().finally(() => (running = undefined));
    return running;
  };
  const tick = () =>
    void checkOnce().catch((error: unknown) =>
      d.log.error("nudge.check_failed", { error }),
    );
  return {
    checkOnce,
    start: () => {
      timers = [
        setTimeout(tick, 0),
        setInterval(tick, d.settings.nudges.checkIntervalMs),
      ];
    },
    // Starts no new check or action. A running nudge turn ends when the scheduler stops.
    stop: () => {
      stopped = true;
      timers.forEach((timer) => clearTimeout(timer));
    },
    settled: () => running ?? Promise.resolve(),
    readiness: () => readiness(d, lastCheckAt),
  };
}
