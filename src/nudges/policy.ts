import type { Env } from "../config/env.ts";
import { ConfigError, parseDuration } from "../config/env.ts";
import type { ChatState, Entry } from "../conversation/entry.ts";
import { isAgentActivity, latestCustomerAt } from "../conversation/record.ts";

export interface NudgeSettings {
  nudges: boolean;
  expiry: boolean;
  intervalMs: number;
  milestonesMs: number[];
  hours: { from: number; to: number };
  expiryMs: number;
  exemptLabel: string;
  instruction: string;
}

function parseHours(value: string) {
  const match = value.match(/^(\d{1,2})-(\d{1,2})$/);
  const [from, to] = [Number(match?.[1]), Number(match?.[2])];
  if (!match || from > 23 || to > 24 || from >= to) {
    throw new ConfigError(
      `Invalid NUDGE_HOURS="${value}". Use "<from>-<to>" in whole hours, for example "8-22".`,
    );
  }
  return { from, to };
}

export function parseNudgeSettings(env: Env): NudgeSettings {
  const milestones = env.list("NUDGE_MILESTONES", [
    "5m",
    "35m",
    "12h35m",
    "12h45m",
  ]);
  return {
    nudges: env.bool("NUDGES_ENABLED", true),
    expiry: env.bool("EXPIRY_ENABLED", true),
    intervalMs: env.duration("NUDGE_CHECK_INTERVAL", "5m"),
    milestonesMs: milestones
      .map((value) => parseDuration(env.name("NUDGE_MILESTONES"), value))
      .toSorted((a, b) => a - b),
    hours: parseHours(env.string("NUDGE_HOURS", "0-24")),
    expiryMs: env.duration("EXPIRY_AFTER", "13h45m"),
    exemptLabel: env.string("EXPIRY_EXEMPT_LABEL", "out-of-scope-unsolved"),
    instruction: env.string("NUDGE_INSTRUCTION", "Nudge"),
  };
}

function activityTimes(entries: Entry[], since: string) {
  return entries
    .filter((entry) => isAgentActivity(entry) && entry.at >= since)
    .map((entry) => Date.parse(entry.at));
}

export function expiryDue(
  entries: Entry[],
  state: ChatState,
  settings: NudgeSettings,
  now: number,
) {
  const customerAt = latestCustomerAt(entries);
  if (!settings.expiry || !customerAt || state.expiredFor === customerAt)
    return undefined;
  const elapsedMs = now - Date.parse(customerAt);
  if (
    elapsedMs < settings.expiryMs ||
    activityTimes(entries, customerAt).length === 0
  )
    return undefined;
  return { customerAt, elapsedMs };
}

export function nudgeDue(
  entries: Entry[],
  state: ChatState,
  settings: NudgeSettings,
  now: number,
) {
  const customerAt = latestCustomerAt(entries);
  if (!settings.nudges || !customerAt || state.expiredFor === customerAt)
    return undefined;
  const start = Date.parse(customerAt);
  const activity = activityTimes(entries, customerAt);
  const milestoneMs = settings.milestonesMs.find(
    (offset) =>
      start + offset <= now && !activity.some((time) => time >= start + offset),
  );
  return milestoneMs;
}
