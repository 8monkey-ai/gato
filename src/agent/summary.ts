import type { LanguageModel } from "ai";
import { generateText } from "ai";

import type { Attachment, Entry, MessageEntry } from "../conversation/entry.ts";
import { messages } from "../conversation/record.ts";
import type { Conversation } from "../conversation/store.ts";
import { readText, writeText } from "../conversation/store.ts";
import { errorText, log } from "../log.ts";
import { formatLocal, monthBefore } from "../time.ts";
import type { Budget } from "./runner.ts";

export interface Summary {
  date: Date;
  text: string;
}

export interface SummaryDeps {
  model: LanguageModel;
  promptFile: string;
  timezone: string;
}

const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

const speakers: Partial<Record<MessageEntry["role"], string>> = {
  customer: "Customer",
  operator: "Human colleague",
  agent: "Agent",
};

function parseSummary(text: string | undefined): Summary | undefined {
  const match = text?.match(/^Date: (.+)\n\n([\s\S]*)$/);
  if (!match) return undefined;
  const date = new Date(match[1]!);
  return Number.isNaN(date.getTime()) ? undefined : { date, text: match[2]! };
}

function attachmentLine(attachment: Attachment) {
  const name = attachment.name ? ` "${attachment.name}"` : "";
  const content = attachment.prepared ? `: ${attachment.prepared.text}` : "";
  return `[${attachment.category} attachment${name}${content}]`;
}

function sourceEntries(entries: Entry[], since: Date) {
  return messages(entries).filter(
    (entry) =>
      speakers[entry.role] &&
      (entry.role !== "agent" || entry.delivery === "sent") &&
      new Date(entry.at) >= since,
  );
}

function transcript(entries: MessageEntry[], timezone: string) {
  return entries
    .map((entry) => {
      const content = [
        entry.text,
        ...(entry.attachments ?? []).map(attachmentLine),
      ]
        .filter(Boolean)
        .join(" ");
      return `[${formatLocal(entry.at, timezone)}] ${speakers[entry.role]}: ${content}`;
    })
    .join("\n");
}

async function generate(
  source: MessageEntry[],
  deps: SummaryDeps,
  budget: Budget,
) {
  if (budget.steps <= 0)
    throw new Error("The work limit was reached before the summary.");
  budget.steps--;
  const { text } = await generateText({
    model: deps.model,
    instructions: await Bun.file(deps.promptFile).text(),
    prompt: transcript(source, deps.timezone),
    abortSignal: budget.signal,
    maxRetries: 0,
  });
  return text.trim();
}

export async function summaryForTurn(
  conversation: Conversation,
  deps: SummaryDeps,
  budget: Budget,
  now = new Date(),
) {
  const saved = parseSummary(await readText(conversation, "summary.txt"));
  if (saved && now.getTime() - saved.date.getTime() < threeDaysMs) return saved;
  const source = sourceEntries(
    conversation.entries,
    monthBefore(now, deps.timezone),
  );
  if (source.length === 0) return saved;
  if (!saved && now.getTime() - new Date(source[0]!.at).getTime() < threeDaysMs)
    return undefined;
  try {
    const text = await generate(source, deps, budget);
    if (text === "") return saved;
    await writeText(
      conversation,
      "summary.txt",
      `Date: ${now.toISOString()}\n\n${text}`,
    );
    return { date: now, text };
  } catch (error) {
    log("warn", "summary.failed", {
      connection: conversation.connection,
      chat: conversation.chat,
      error: errorText(error),
    });
    return undefined;
  }
}
