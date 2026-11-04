import type { ChatView, RecordedMessage } from "./projection.ts";
import type { Attachment, Author, Delivery } from "./types.ts";

type Line = { time: string; seq: number; text: string };

function formatTime(iso: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${timeZone}`;
}

const indent = (text: string) => text.replaceAll("\n", "\n  ");

function authorName(author: Author): string {
  if (author.role === "operator")
    return `Operator ${author.name ?? author.id ?? "(unknown)"}`;
  if (author.role === "workflow")
    return author.id ? `Workflow ${author.id}` : "Workflow";
  return author.role === "customer" ? "Customer" : "Agent";
}

const deliveryNotes: Partial<Record<Delivery, string>> = {
  pending: " (pending)",
  uncertain: " (uncertain)",
  failed: " (failed)",
  superseded: " (superseded, not sent)",
};

function attachmentLine(a: Attachment): string {
  const details = [
    `${a.category}: ${a.fileName ?? "unnamed"}${a.file ? ` -> ${a.file}` : ""}`,
  ];
  if (a.retrievalError) details.push(`retrieval failed: ${a.retrievalError}`);
  const prepared = a.preparation;
  if (prepared && "text" in prepared)
    details.push(
      `${a.category === "audio" ? "transcript" : "interpretation"}: ${prepared.text}`,
    );
  if (prepared && "error" in prepared)
    details.push(`preparation failed: ${prepared.error}`);
  return `\n  [${indent(details.join("; "))}]`;
}

function messageLine(m: RecordedMessage): Line {
  const status =
    (deliveryNotes[m.delivery] ?? "") + (m.error ? ` error: ${m.error}` : "");
  const text = `${authorName(m.author)}${status}: ${indent(m.text ?? "")}${m.attachments.map(attachmentLine).join("")}`;
  return { time: m.sentAt, seq: m.seq, text };
}

type RecordEntry = ChatView[
  "notes" | "handoffs" | "toolActivity" | "triggers" | "merges"][number];

function recordText(e: RecordEntry): string {
  if (e.type === "note") return `# note (${e.kind}, ${e.by}): ${e.text}`;
  if (e.type === "handoff") return `# handoff (${e.path}): ${e.reason}`;
  if (e.type === "tool-call")
    return `# tool call ${e.name}: ${JSON.stringify(e.input)}`;
  if (e.type === "tool-result")
    return `# tool ${e.isError ? "error" : "result"} ${e.name}: ${JSON.stringify(e.output)}`;
  if (e.type === "trigger") return `# trigger: ${e.text}`;
  return `# merge: history of ${e.fromChatId} merged into this chat`;
}

export function renderChat(view: ChatView, timeZone: string): string {
  const records = [
    ...view.notes,
    ...view.handoffs,
    ...view.toolActivity,
    ...view.triggers,
    ...view.merges,
  ].map((e) => ({ time: e.at, seq: e.seq, text: indent(recordText(e)) }));
  return [...view.messages.map(messageLine), ...records]
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || a.seq - b.seq)
    .map((line) => `[${formatTime(line.time, timeZone)}] ${line.text}\n`)
    .join("");
}
