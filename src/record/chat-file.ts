import type { Entry } from "./entries.ts";

const header = /^\[([^\]]+)\] ([^{]*)(\{.*\})$/;
const entryTypes = new Set(["message", "note", "tool", "turn"]);

function label(entry: Entry): string {
  switch (entry.type) {
    case "message":
      return [entry.role, entry.sender, entry.delivery && `(${entry.delivery})`]
        .filter(Boolean)
        .join(" ");
    case "note":
      return `note ${entry.kind}`;
    case "tool":
      return `tool ${entry.name}`;
    case "turn":
      return `turn ${entry.trigger} ${entry.status}`;
  }
}

function body(entry: Entry): string | undefined {
  return entry.type === "message" || entry.type === "note"
    ? entry.text
    : undefined;
}

export function serializeChat(entries: readonly Entry[]): string {
  return entries
    .map((entry) => {
      const { at, ...rest } = entry;
      const text = body(entry);
      const meta = text === undefined ? rest : { ...rest, text: undefined };
      const title = label(entry).replaceAll(/[{}\n\r]/g, " ");
      const lines = [`[${at}] ${title} ${JSON.stringify(meta)}`];
      if (text) lines.push(...text.split("\n").map((line) => `> ${line}`));
      return lines.join("\n") + "\n";
    })
    .join("");
}

function isEntryMeta(meta: { type?: unknown; id?: unknown } | null) {
  return (
    typeof meta?.type === "string" &&
    entryTypes.has(meta.type) &&
    typeof meta.id === "string"
  );
}

function parseHeader(line: string, lineNumber: number): Entry {
  const match = header.exec(line);
  if (!match) throw new Error(`line ${lineNumber}: not an entry header`);
  const [, at = "", , json = ""] = match;
  if (Number.isNaN(Date.parse(at)))
    throw new Error(`line ${lineNumber}: invalid time "${at}"`);
  const meta = JSON.parse(json) as { type?: unknown; id?: unknown } | null;
  if (!isEntryMeta(meta))
    throw new Error(`line ${lineNumber}: invalid entry metadata`);
  const entry = { ...meta, at: new Date(at).toISOString() } as Entry;
  if (entry.type === "message" || entry.type === "note") entry.text = "";
  return entry;
}

/** Throws with the line number when the file is damaged. */
export function parseChat(content: string): Entry[] {
  const entries: Entry[] = [];
  const bodies = new Map<Entry, string[]>();
  content.split("\n").forEach((line, index) => {
    if (line === "") return;
    const last = entries.at(-1);
    if (line.startsWith(">")) {
      if (!last || !bodies.has(last))
        throw new Error(`line ${index + 1}: text without a message`);
      bodies.get(last)?.push(line.slice(2));
      return;
    }
    const entry = parseHeader(line, index + 1);
    entries.push(entry);
    if (entry.type === "message" || entry.type === "note")
      bodies.set(entry, []);
  });
  for (const [entry, lines] of bodies)
    if (entry.type === "message" || entry.type === "note")
      entry.text = lines.join("\n");
  return entries;
}
