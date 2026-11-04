import { generateText } from "ai";

import type { TurnBudget } from "../agent/budget.ts";
import type { ModelProvider } from "../agent/models.ts";
import { attachmentName, preparedText } from "../attachments/representation.ts";
import { selectHistory } from "../context/history.ts";
import type { Logger } from "../log.ts";
import type { ChatView, RecordedMessage } from "../record/projection.ts";
import type { Author, ChatRef } from "../record/types.ts";
import type { ChatStore } from "../storage/chat-store.ts";
import { summaryDecision } from "./policy.ts";

type Input = {
  store: Pick<ChatStore, "readSummary" | "writeSummary">;
  ref: ChatRef;
  view: ChatView;
  now: Date;
  timeZone: string;
  modelId: string;
  provider: ModelProvider;
  prompt: string;
  budget: TurnBudget;
  log: Logger;
};

const speakers: Partial<Record<Author["role"], string>> = {
  customer: "Customer",
  operator: "Human colleague",
  agent: "Agent",
};

function minuteStamp(iso: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function sourceLine(message: RecordedMessage, timeZone: string) {
  const speaker = speakers[message.author.role];
  if (!speaker) return [];
  const content = [
    message.text ?? "",
    ...message.attachments.map(
      (a) => preparedText(a) ?? `[${attachmentName(a)}]`,
    ),
  ]
    .filter((part) => part !== "")
    .join(" ");
  return [`[${minuteStamp(message.sentAt, timeZone)}] ${speaker}: ${content}`];
}

function recentMessages(input: Input) {
  return selectHistory(input.view, {
    scope: "recent-month",
    includeToolActivity: false,
    now: input.now,
    timeZone: input.timeZone,
  }).flatMap((item) => (item.kind === "message" ? [item.message] : []));
}

async function generate(input: Input, source: string, previous?: string) {
  try {
    const result = await generateText({
      model: input.provider(input.modelId),
      instructions: input.prompt,
      prompt: source,
      maxRetries: 0,
      abortSignal: input.budget.signal,
    });
    const text = result.text.trim();
    if (text === "") return previous;
    await input.store.writeSummary(input.ref, {
      generatedAt: input.now.toISOString(),
      text,
    });
    return text;
  } catch (error) {
    if (input.budget.signal.aborted) throw error;
    input.log.warn("summary.failed", { error });
    return undefined;
  }
}

export async function ensureSummary(input: Input): Promise<string | undefined> {
  const saved = await input.store.readSummary(input.ref);
  const messages = recentMessages(input);
  const decision = summaryDecision({
    now: input.now,
    summaryGeneratedAt: saved && new Date(saved.generatedAt),
    oldestRecentMessageAt: messages[0] && new Date(messages[0].sentAt),
  });
  if (decision === "reuse" || decision === "none") return saved?.text;
  const lines = messages.flatMap((m) => sourceLine(m, input.timeZone));
  if (lines.length === 0) return saved?.text;
  input.budget.take();
  return generate(input, lines.join("\n"), saved?.text);
}
