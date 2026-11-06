import type { Channel } from "../channels/channel.ts";
import { addNote } from "../conversation/notes.ts";
import type { Conversations } from "../conversation/service.ts";
import { errorText, log } from "../log.ts";
import {
  latestAgentActivity,
  latestCustomerActivity,
  pendingMessages,
} from "../record/activity.ts";
import type { Chat, ChatStore } from "../record/store.ts";
import { type Hours, selectMilestone, withinHours } from "./policy.ts";

export interface NudgeSettings {
  intervalMs: number;
  milestones: number[];
  hours: Hours;
  timezone: string;
}

function dueMilestone(chat: Chat, settings: NudgeSettings): number | undefined {
  const now = new Date();
  if (!withinHours(now, settings.timezone, settings.hours)) return undefined;
  return selectMilestone(
    now,
    latestCustomerActivity(chat.entries),
    latestAgentActivity(chat.entries),
    settings.milestones,
  );
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} minutes`;
}

/** Checks ownership and activity again right before the nudge, then commits it with a note. */
function confirmNudge(
  chat: Chat,
  channel: Channel,
  milestone: number,
  settings: NudgeSettings,
) {
  return async () => {
    if (pendingMessages(chat.entries).length) return false;
    if (!(await channel.agentOwns(chat.id))) return false;
    if (dueMilestone(chat, settings) !== milestone) return false;
    await addNote(chat, channel, {
      author: "agent",
      kind: "nudge",
      text: `Nudge: ${minutes(milestone)} after the latest customer message`,
    });
    log.info("nudge.started", {
      conversation: chat.id,
      channel: channel.name,
      milestone,
    });
    return true;
  };
}

export async function checkNudges(
  store: ChatStore,
  channels: Channel[],
  conversations: Conversations,
  settings: NudgeSettings,
) {
  for (const chat of store.all()) {
    const channel = channels.find((c) => c.name === chat.connection);
    if (!channel || !conversations.isIdle(chat)) continue;
    if (pendingMessages(chat.entries).length) continue;
    const milestone = dueMilestone(chat, settings);
    if (milestone === undefined) continue;
    await conversations.nudge(
      channel,
      chat,
      confirmNudge(chat, channel, milestone, settings),
    );
  }
}

/** One check runs at a time. A conversation gets at most one nudge per check. */
export function scheduleNudges(run: () => Promise<void>, intervalMs: number) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    run()
      .catch((error: unknown) =>
        log.error("nudge.check_failed", { error: errorText(error) }),
      )
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return () => clearInterval(timer);
}
