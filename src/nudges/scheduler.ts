import type { Channel } from "../channels/channel.ts";
import { handoff } from "../conversation/handoff.ts";
import { addNote } from "../conversation/notes.ts";
import type { Conversation } from "../conversation/store.ts";
import { errorText, log } from "../log.ts";
import type { NudgeSettings } from "./policy.ts";
import { expiryDue, nudgeDue } from "./policy.ts";

export interface NudgeDeps {
  settings: NudgeSettings;
  timezone: string;
  conversations: () => Conversation[];
  channelOf: (conversation: Conversation) => Channel | undefined;
  eligible: (conversation: Conversation) => boolean;
  busy: (conversation: Conversation) => boolean;
  refresh: (conversation: Conversation) => Promise<void>;
  requestNudge: (conversation: Conversation) => void;
}

function withinHours(settings: NudgeSettings, timezone: string, now: number) {
  const hour =
    Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(
      timezone,
    ).hour;
  return hour >= settings.hours.from && hour < settings.hours.to;
}

function elapsed(ms: number) {
  const minutes = Math.floor(ms / 60_000);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function fields(conversation: Conversation) {
  return { connection: conversation.connection, chat: conversation.chat };
}

async function labelsOf(conversation: Conversation, channel: Channel) {
  return channel.labels
    ? await channel.labels.list(conversation.chat)
    : conversation.state.labels;
}

async function expire(
  deps: NudgeDeps,
  conversation: Conversation,
  channel: Channel,
  now: number,
) {
  const due = expiryDue(
    conversation.entries,
    conversation.state,
    deps.settings,
    now,
  );
  if (!due) return false;
  let labels: string[];
  try {
    labels = await labelsOf(conversation, channel);
  } catch (error) {
    log("warn", "expiry.labels_unavailable", {
      ...fields(conversation),
      error: errorText(error),
    });
    return false;
  }
  if (labels.includes(deps.settings.exemptLabel)) return false;
  conversation.state.expiredFor = due.customerAt;
  const reason = `Expired after ${elapsed(due.elapsedMs)} without a customer reply.`;
  await handoff(conversation, channel, { kind: "expired", reason });
  return true;
}

async function nudge(
  deps: NudgeDeps,
  conversation: Conversation,
  channel: Channel,
  now: number,
) {
  const due = nudgeDue(
    conversation.entries,
    conversation.state,
    deps.settings,
    now,
  );
  if (due === undefined || !withinHours(deps.settings, deps.timezone, now))
    return;
  await addNote(conversation, channel, {
    type: "nudge",
    text: deps.settings.instruction,
    byAgent: true,
  });
  log("info", "nudge.started", { ...fields(conversation), milestoneMs: due });
  deps.requestNudge(conversation);
}

function ready(deps: NudgeDeps, conversation: Conversation) {
  return deps.eligible(conversation) && !deps.busy(conversation);
}

async function checkOne(
  deps: NudgeDeps,
  conversation: Conversation,
  now: number,
) {
  const channel = deps.channelOf(conversation);
  if (!channel || !ready(deps, conversation)) return;
  const { entries, state } = conversation;
  if (
    !expiryDue(entries, state, deps.settings, now) &&
    nudgeDue(entries, state, deps.settings, now) === undefined
  )
    return;
  await deps.refresh(conversation);
  if (!ready(deps, conversation)) return;
  if (await expire(deps, conversation, channel, now)) return;
  await nudge(deps, conversation, channel, now);
}

export function createNudges(deps: NudgeDeps) {
  let lastCheck: string | undefined;
  let running: Promise<void> | undefined;
  async function check() {
    const now = Date.now();
    for (const conversation of deps.conversations()) {
      await checkOne(deps, conversation, now).catch((error: unknown) =>
        log("warn", "nudge.check_failed", {
          ...fields(conversation),
          error: errorText(error),
        }),
      );
    }
    lastCheck = new Date(now).toISOString();
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    start() {
      if (!deps.settings.nudges && !deps.settings.expiry) return;
      timer = setInterval(() => {
        running ??= check().finally(() => (running = undefined));
      }, deps.settings.intervalMs);
    },
    async stop() {
      clearInterval(timer);
      await running;
    },
    status: () => ({
      nudges: deps.settings.nudges,
      expiry: deps.settings.expiry,
      lastCheck,
    }),
  };
}
