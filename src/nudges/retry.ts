import type { Controls } from "../conversation/controls.ts";
import {
  agentMayAnswer,
  type OwnershipPolicy,
} from "../conversation/ownership.ts";
import type { createScheduler } from "../conversation/scheduler.ts";
import type { Logger } from "../log.ts";
import type { ChatView } from "../record/projection.ts";
import type { ChatRef, TurnEnd } from "../record/types.ts";
import type { ChatStore } from "../storage/chat-store.ts";
import { healthyChats } from "./chats.ts";
import { recordNudgeOutcome } from "./outcome.ts";
import { retryEligible } from "./retry-eligibility.ts";

type Deps = {
  store: Pick<ChatStore, "list" | "load" | "damaged">;
  controls: Pick<Controls, "state" | "note">;
  policy: OwnershipPolicy;
};
type RetryDeps = Deps & {
  scheduler: Pick<ReturnType<typeof createScheduler>, "runExclusive">;
  log: Logger;
};

function latestFailure(view: ChatView, since: Date) {
  const failure = view.notes
    .filter((n) => n.kind === "nudge-failed" && new Date(n.at) >= since)
    .at(-1);
  if (!failure) return undefined;
  const attempt = view.notes
    .filter((n) => n.kind === "nudge" && n.seq < failure.seq)
    .at(-1);
  return { attemptAt: new Date((attempt ?? failure).at), reason: failure.text };
}

const substantiveMessageTimes = (view: ChatView) =>
  view.messages
    .filter(
      (m) =>
        m.author.role !== "agent" ||
        m.delivery === "sent" ||
        m.delivery === "observed",
    )
    .map((m) => new Date(m.sentAt));

async function failedNudge(deps: Deps, ref: ChatRef, since: Date) {
  const failure = latestFailure(await deps.store.load(ref), since);
  if (!failure) return undefined;
  const { owner, open, view } = await deps.controls.state(ref);
  const eligible = retryEligible({
    attemptAt: failure.attemptAt,
    open,
    agentOwned: agentMayAnswer(owner, deps.policy),
    substantiveMessageTimes: substantiveMessageTimes(view),
  });
  return { ref, ...failure, eligible };
}

export async function failedNudges(deps: Deps, since: Date) {
  const found = await Promise.all(
    healthyChats(deps.store).map((ref) => failedNudge(deps, ref, since)),
  );
  return found.filter((f) => f !== undefined);
}

async function retry(deps: RetryDeps, ref: ChatRef) {
  try {
    const outcome = await deps.scheduler.runExclusive(ref, "nudge-retry");
    await recordNudgeOutcome(deps.controls, ref, outcome);
    return { ref, outcome };
  } catch (error) {
    deps.log.error("nudge.retry_failed", { ...ref, error });
    return { ref, outcome: "error" as TurnEnd | "busy" | "error" };
  }
}

export async function retryFailedNudges(deps: RetryDeps, since: Date) {
  const eligible = (await failedNudges(deps, since)).filter((f) => f.eligible);
  return Promise.all(eligible.map((f) => retry(deps, f.ref)));
}
