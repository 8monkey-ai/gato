import { generateText, type LanguageModel } from "ai";

import { isVisible } from "../conversation/history.ts";
import { log } from "../log.ts";
import type { Entry, MessageEntry } from "../record/chat-file.ts";
import type { Conversation } from "../record/store.ts";

const threeDays = 3 * 24 * 60 * 60 * 1000;

const speaker: Record<MessageEntry["role"], string | undefined> = {
  customer: "Customer",
  operator: "Human colleague",
  agent: "Agent",
  workflow: undefined,
};

export function summarySource(
  entries: readonly Entry[],
  now: Date,
): MessageEntry[] {
  const monthAgo = new Date(now);
  monthAgo.setUTCMonth(monthAgo.getUTCMonth() - 1);
  return entries.filter(
    (e): e is MessageEntry =>
      isVisible(e) &&
      speaker[e.role] !== undefined &&
      Date.parse(e.at) >= monthAgo.getTime(),
  );
}

export function needsSummary(
  summary: { at: string } | undefined,
  source: readonly MessageEntry[],
  now: Date,
): boolean {
  if (summary)
    return (
      now.getTime() - Date.parse(summary.at) >= threeDays && source.length > 0
    );
  const oldest = source[0];
  return !!oldest && now.getTime() - Date.parse(oldest.at) >= threeDays;
}

export async function contactSummary(
  conversation: Conversation,
  deps: {
    model: LanguageModel;
    prompt: string;
    timezone: string;
    signal: AbortSignal;
  },
): Promise<string | undefined> {
  const now = new Date();
  const saved = conversation.summary;
  const source = summarySource(conversation.entries, now);
  if (!needsSummary(saved, source, now)) return saved?.text;
  try {
    const { text } = await generateText({
      model: deps.model,
      instructions: deps.prompt,
      prompt: transcript(source, deps.timezone),
      abortSignal: deps.signal,
    });
    if (!text.trim()) return saved?.text;
    await conversation.saveSummary({
      at: now.toISOString(),
      text: text.trim(),
    });
    return text.trim();
  } catch (error) {
    if (deps.signal.aborted) throw error;
    log.warn("summary.failed", {
      connection: conversation.connection,
      contact: conversation.contact,
      error,
    });
    return undefined;
  }
}

export function transcript(
  source: readonly MessageEntry[],
  timeZone: string,
): string {
  const format = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    dateStyle: "short",
    timeStyle: "short",
  });
  return source
    .map((entry) => {
      const files = (entry.attachments ?? []).map(
        (a) =>
          `[${a.kind}${a.name ? ` "${a.name}"` : ""}${a.prepared ? `: ${a.prepared.text}` : ""}]`,
      );
      const content = [entry.text, ...files].filter(Boolean).join(" ");
      return `[${format.format(new Date(entry.at))}] ${speaker[entry.role]}: ${content}`;
    })
    .join("\n");
}
