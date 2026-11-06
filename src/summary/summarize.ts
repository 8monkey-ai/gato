import { generateText, type LanguageModel } from "ai";

import { visibleMessages } from "../agent/context.ts";
import { WorkLimitError } from "../agent/models.ts";
import { errorText, log } from "../log.ts";
import type { Attachment, MessageEntry } from "../record/entries.ts";
import type { Chat, Summary } from "../record/store.ts";
import { decideSummary, monthBefore } from "./policy.ts";

const speakers = {
  customer: "Customer",
  operator: "Human colleague",
  workflow: "Workflow",
  agent: "Agent",
} as const;

function attachmentText(attachment: Attachment): string {
  const name = attachment.name ? ` "${attachment.name}"` : "";
  return attachment.prepared
    ? `[${attachment.category}${name}: ${attachment.prepared.text}]`
    : `[${attachment.category}${name}]`;
}

function line(message: MessageEntry, timezone: string): string {
  const time = new Date(message.at).toLocaleString("sv-SE", {
    timeZone: timezone,
  });
  const sender = message.sender ? ` ${message.sender}` : "";
  const content = [
    message.text,
    ...(message.attachments ?? []).map(attachmentText),
  ]
    .filter(Boolean)
    .join(" ");
  return `${time} ${speakers[message.role]}${sender}: ${content}`;
}

/** Returns the summary for this turn's context. A failed refresh never replaces the saved summary. */
export async function summaryForTurn(options: {
  chat: Chat;
  now: Date;
  timezone: string;
  prompt: string;
  model: LanguageModel;
  signal: AbortSignal;
}): Promise<Summary | undefined> {
  const { chat, now } = options;
  const since = monthBefore(now).toISOString();
  const source = visibleMessages(chat.entries).filter((m) => m.at >= since);
  const oldest = source[0] && new Date(source[0].at);
  const decision = decideSummary(now, chat.summary?.date, oldest);
  if (decision !== "generate")
    return decision === "reuse" ? chat.summary : undefined;
  if (!source.length) return chat.summary;
  try {
    const { text } = await generateText({
      model: options.model,
      instructions: options.prompt,
      prompt: source.map((m) => line(m, options.timezone)).join("\n"),
      abortSignal: options.signal,
    });
    if (!text.trim()) return chat.summary;
    const summary = { date: now, text: text.trim() };
    await chat.saveSummary(summary);
    return summary;
  } catch (error) {
    if (options.signal.aborted || error instanceof WorkLimitError) throw error;
    log.warn("summary.failed", {
      conversation: chat.id,
      error: errorText(error),
    });
    return undefined;
  }
}
