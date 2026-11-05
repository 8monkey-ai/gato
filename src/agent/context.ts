import type { FilePart, ModelMessage, TextPart } from "ai";

import type {
  Entry,
  MessageEntry,
  NoteEntry,
  ToolCallEntry,
  ToolResultEntry,
} from "../conversation/entry.ts";
import { isVisible } from "../conversation/record.ts";

export type ContentPart = TextPart | FilePart;

export type RenderMessage = (entry: MessageEntry) => ContentPart[];

export interface ContextOptions {
  turn: string;
  includeTools: boolean;
  render: RenderMessage;
}

function attribution(entry: MessageEntry) {
  const name =
    entry.sender === "unknown" ? "unknown sender" : entry.sender?.name;
  if (entry.role === "operator")
    return name ? `[Human colleague, ${name}]` : "[Human colleague]";
  if (entry.role === "workflow") return "[Automated workflow]";
  return undefined;
}

function messageToModel(
  entry: MessageEntry,
  render: RenderMessage,
): ModelMessage {
  const label = attribution(entry);
  const parts = render(entry);
  const content = label
    ? [{ type: "text" as const, text: label }, ...parts]
    : parts;
  if (entry.role === "customer") return { role: "user", content };
  return { role: "assistant", content };
}

function toolCallToModel(entry: ToolCallEntry): ModelMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: entry.callId,
        toolName: entry.tool,
        input: entry.input,
      },
    ],
  };
}

function toolResultToModel(entry: ToolResultEntry): ModelMessage {
  const output = entry.error
    ? { type: "error-text" as const, value: String(entry.output) }
    : { type: "json" as const, value: (entry.output ?? null) as never };
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: entry.callId,
        toolName: entry.tool,
        output,
      },
    ],
  };
}

function completedCalls(entries: Entry[]) {
  return new Set(
    entries
      .filter((entry) => entry.kind === "tool-result")
      .map((entry) => entry.callId),
  );
}

function included(
  entry: Entry,
  options: ContextOptions,
  answered: Set<string>,
) {
  if (entry.kind === "message") return isVisible(entry);
  if (entry.kind === "note") return false;
  if (entry.kind === "trigger") {
    return options.includeTools || entry.turn === options.turn;
  }
  return options.includeTools && answered.has(entry.callId);
}

function toModel(
  entry: Exclude<Entry, NoteEntry>,
  render: RenderMessage,
): ModelMessage {
  if (entry.kind === "message") return messageToModel(entry, render);
  if (entry.kind === "tool-call") return toolCallToModel(entry);
  if (entry.kind === "tool-result") return toolResultToModel(entry);
  return { role: "user", content: entry.text };
}

export function toModelMessages(entries: Entry[], options: ContextOptions) {
  const answered = completedCalls(entries);
  return entries
    .filter((entry): entry is Exclude<Entry, NoteEntry> =>
      included(entry, options, answered),
    )
    .map((entry) => toModel(entry, options.render));
}
