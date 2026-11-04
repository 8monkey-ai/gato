import type { ChatView } from "../record/projection.ts";

type NudgeInput = {
  now: Date;
  latestCustomerAt?: Date;
  agentActivity: Date[];
  milestonesMs: number[];
  expiryAfterMs: number;
  nudgesEnabled: boolean;
  expiryEnabled: boolean;
  exemptLabelState: "present" | "absent" | "unknown";
  withinPermittedHours: boolean;
};

type NudgeAction =
  | { kind: "none"; reason: string }
  | { kind: "expire"; elapsedMs: number }
  | { kind: "nudge"; milestoneIndex: number };

const UNKNOWN_LABELS = "expiry skipped: exemption labels unavailable";

export function selectAction(input: NudgeInput): NudgeAction {
  const customerAt = input.latestCustomerAt?.getTime();
  if (customerAt === undefined) {
    return { kind: "none", reason: "no customer activity" };
  }
  const elapsedMs = input.now.getTime() - customerAt;
  const expiryBlock = expiryBlockReason(input, customerAt, elapsedMs);
  if (expiryBlock === undefined) return { kind: "expire", elapsedMs };
  const nudge = selectNudge(input, customerAt);
  if (nudge.kind === "none" && expiryBlock === UNKNOWN_LABELS) {
    return { kind: "none", reason: expiryBlock };
  }
  return nudge;
}

function expiryBlockReason(
  input: NudgeInput,
  customerAt: number,
  elapsedMs: number,
): string | undefined {
  if (!input.expiryEnabled) return "expiry disabled";
  if (elapsedMs < input.expiryAfterMs) return "expiry threshold not reached";
  if (!hasActivitySince(input.agentActivity, customerAt)) {
    return "no agent activity since the customer message";
  }
  if (input.exemptLabelState === "present") return "expiry exempt by label";
  if (input.exemptLabelState === "unknown") return UNKNOWN_LABELS;
  return undefined;
}

function selectNudge(input: NudgeInput, customerAt: number): NudgeAction {
  if (!input.nudgesEnabled) return { kind: "none", reason: "nudges disabled" };
  if (!input.withinPermittedHours) {
    return { kind: "none", reason: "outside permitted hours" };
  }
  const now = input.now.getTime();
  const milestoneIndex = input.milestonesMs.findIndex(
    (offset) =>
      now >= customerAt + offset &&
      !hasActivitySince(input.agentActivity, customerAt + offset),
  );
  if (milestoneIndex === -1)
    return { kind: "none", reason: "no milestone due" };
  return { kind: "nudge", milestoneIndex };
}

function hasActivitySince(activity: Date[], since: number): boolean {
  return activity.some((at) => at.getTime() >= since);
}

export function withinHours(
  now: Date,
  window: { startMinutes: number; endMinutes: number },
  timeZone: string,
): boolean {
  const minute = minuteOfDay(now, timeZone);
  if (window.startMinutes > window.endMinutes) {
    return minute >= window.startMinutes || minute < window.endMinutes;
  }
  return minute >= window.startMinutes && minute < window.endMinutes;
}

function minuteOfDay(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(date);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  return value("hour") * 60 + value("minute");
}

// The latest expiry since the latest customer message; a new customer message ends the expiry.
export function expiredAt(view: ChatView): string | undefined {
  const latest = view.latestCustomerAt;
  if (latest === undefined) return undefined;
  return view.notes
    .filter(
      (n) => n.kind === "expiry" && Date.parse(n.at) >= Date.parse(latest),
    )
    .at(-1)?.at;
}
