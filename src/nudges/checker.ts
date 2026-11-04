import type { ChannelConnection } from "../channels/channel.ts";
import type { Settings } from "../config/settings.ts";
import type { Controls } from "../conversation/controls.ts";
import { agentMayAnswer } from "../conversation/ownership.ts";
import type { createScheduler } from "../conversation/scheduler.ts";
import type { Logger } from "../log.ts";
import type { ChatView } from "../record/projection.ts";
import type { ChatRef } from "../record/types.ts";
import type { ChatStore } from "../storage/chat-store.ts";
import { healthyChats } from "./chats.ts";
import { recordNudgeOutcome } from "./outcome.ts";
import { selectAction, withinHours } from "./policy.ts";
import { createReconciler } from "./reconcile.ts";

type Deps = {
  store: ChatStore;
  controls: Pick<Controls, "state" | "note" | "handoff" | "readLabels">;
  scheduler: Pick<
    ReturnType<typeof createScheduler>,
    "busy" | "runExclusive" | "ownershipChange"
  >;
  connection: (connectionId: string) => ChannelConnection;
  settings: Pick<Settings, "nudges" | "ownershipPolicy" | "timeZone">;
  log: Logger;
  now: () => Date;
};

function agentActivity(view: ChatView) {
  const messages = view.messages
    .filter(
      (m) =>
        m.author.role === "agent" &&
        (m.delivery === "sent" || m.delivery === "observed"),
    )
    .map((m) => m.sentAt);
  const notes = view.notes.filter((n) => n.by === "agent").map((n) => n.at);
  return [...messages, ...notes].map((at) => new Date(at));
}

async function exemptLabelState(
  d: Deps,
  ref: ChatRef,
): Promise<"present" | "absent" | "unknown"> {
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

async function nudgeInput(d: Deps, ref: ChatRef, view: ChatView) {
  const latest = view.latestCustomerAt;
  if (latest === undefined) return undefined;
  const latestCustomerAt = new Date(latest);
  const expired = view.notes.some(
    (n) => n.kind === "expiry" && new Date(n.at) >= latestCustomerAt,
  );
  if (expired) return undefined;
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
    exemptLabelState: expiryDue
      ? await exemptLabelState(d, ref)
      : ("unknown" as const),
    withinPermittedHours: withinHours(now, nudges.hours, timeZone),
  };
}

async function expire(d: Deps, ref: ChatRef, elapsedMs: number) {
  const minutes = Math.floor(elapsedMs / 60_000);
  const reason = `Expired: no customer reply for ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  await d.controls.note(ref, { by: "system", kind: "expiry", text: reason });
  await d.controls.handoff(ref, { path: "expiry", reason });
}

async function nudge(d: Deps, ref: ChatRef) {
  await d.controls.note(ref, { by: "agent", kind: "nudge", text: "Nudge" });
  const outcome = await d.scheduler.runExclusive(ref, "nudge");
  await recordNudgeOutcome(d.controls, ref, outcome);
}

async function checkChat(
  d: Deps,
  reconcile: (ref: ChatRef) => Promise<boolean>,
  ref: ChatRef,
) {
  if (!(await reconcile(ref))) return;
  const { owner, open, view } = await d.controls.state(ref);
  if (!open || !agentMayAnswer(owner, d.settings.ownershipPolicy)) return;
  if (d.scheduler.busy(ref)) return;
  const input = await nudgeInput(d, ref, view);
  if (!input) return;
  const action = selectAction(input);
  if (action.kind === "expire") await expire(d, ref, action.elapsedMs);
  if (action.kind === "nudge") await nudge(d, ref);
}

export function createNudgeChecker(d: Deps) {
  const reconciler = createReconciler({
    ...d,
    onOwnershipChange: d.scheduler.ownershipChange,
  });
  let running: Promise<void> | undefined;
  let lastCheckAt: string | undefined;
  let timers: ReturnType<typeof setTimeout>[] = [];
  const chats = () => healthyChats(d.store);
  const runCheck = async () => {
    await Promise.all(
      chats().map((ref) =>
        checkChat(d, reconciler.reconcile, ref).catch((error: unknown) =>
          d.log.error("nudge.check_failed", { ...ref, error }),
        ),
      ),
    );
    lastCheckAt = d.now().toISOString();
  };
  const checkOnce = () => {
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
    stop: async () => {
      timers.forEach((timer) => clearTimeout(timer));
      await running;
    },
    readiness: () => {
      const refs = chats();
      const reconciledChats = refs.filter(reconciler.isReconciled).length;
      return {
        reconciledChats,
        unreconciledChats: refs.length - reconciledChats,
        lastCheckAt,
      };
    },
  };
}
