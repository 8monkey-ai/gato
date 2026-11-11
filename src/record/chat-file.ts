import { z } from "zod";

const role = z.enum(["customer", "operator", "workflow", "agent"]);
export type Role = z.infer<typeof role>;

const attachmentKind = z.enum(["image", "document", "audio", "video", "other"]);
export type AttachmentKind = z.infer<typeof attachmentKind>;

const attachment = z.object({
  kind: attachmentKind,
  source: z.string(),
  name: z.string().optional(),
  mime: z.string().optional(),
  file: z.string().optional(),
  retrievalError: z.string().optional(),
  prepared: z.object({ model: z.string(), text: z.string() }).optional(),
});
export type Attachment = z.infer<typeof attachment>;

const delivery = z.enum([
  "sending",
  "sent",
  "confirmed",
  "uncertain",
  "failed",
  "unsent",
]);
export type Delivery = z.infer<typeof delivery>;

const messageMeta = z.strictObject({
  sender: z.string().optional(),
  ref: z.string().optional(),
  attachments: z.array(attachment).optional(),
  delivery: delivery.optional(),
  turn: z.string().optional(),
});

const outcome = z.enum([
  "completed",
  "skipped",
  "superseded",
  "failed",
  "timed-out",
  "interrupted",
]);
export type Outcome = z.infer<typeof outcome>;

const trigger = z.enum(["customer", "nudge"]);
export type Trigger = z.infer<typeof trigger>;

const metas = {
  note: z.strictObject({ author: z.enum(["agent", "harness"]) }),
  tool: z.strictObject({
    turn: z.string(),
    name: z.string(),
    failed: z.boolean().optional(),
  }),
  turn: z.strictObject({
    turn: z.string(),
    trigger,
    outcome,
    started: z.iso.datetime(),
  }),
};

type Base = { at: string; text?: string };
export type MessageEntry = Base & { kind: "message"; role: Role } & z.infer<
    typeof messageMeta
  >;
export type NoteEntry = Base & { kind: "note" } & z.infer<typeof metas.note>;
export type ToolEntry = Base & { kind: "tool" } & z.infer<typeof metas.tool>;
export type TurnEntry = Base & { kind: "turn" } & z.infer<typeof metas.turn>;
type DamagedEntry = { kind: "damaged"; at: string; lines: string[] };
export type Entry =
  MessageEntry | NoteEntry | ToolEntry | TurnEntry | DamagedEntry;

const header = /^\[([^\]]+)\] ([a-z]+)(?: (\{.*\}))?$/;
const indent = "  ";

export function serializeChat(entries: readonly Entry[]): string {
  return entries.map(serializeEntry).join("\n\n") + "\n";
}

function serializeEntry(entry: Entry): string {
  if (entry.kind === "damaged") return entry.lines.join("\n");
  const { at, text, kind, ...meta } = entry;
  const tag = "role" in meta ? meta.role : kind;
  const json = JSON.stringify({ ...meta, role: undefined });
  const body =
    text === undefined ? [] : text.split("\n").map((line) => indent + line);
  return [`[${at}] ${tag}${json === "{}" ? "" : ` ${json}`}`, ...body].join(
    "\n",
  );
}

export function parseChat(content: string): {
  entries: Entry[];
  damaged: number;
} {
  const entries: Entry[] = [];
  let damaged = 0;
  for (const block of content.split(/\n(?=\[)/)) {
    const lines = block.replace(/\n+$/, "").split("\n");
    if (!lines[0]) continue;
    const entry = parseEntry(lines);
    if (entry) {
      entries.push(entry);
    } else {
      damaged++;
      entries.push({ kind: "damaged", at: entries.at(-1)?.at ?? "", lines });
    }
  }
  return { entries, damaged };
}

function parseEntry([head = "", ...body]: string[]): Entry | undefined {
  const match = header.exec(head);
  const at = z.iso.datetime({ offset: true }).safeParse(match?.[1]);
  const text = parseBody(body);
  if (!match || !at.success || text === null) return undefined;
  const base = {
    at: new Date(at.data).toISOString(),
    ...(text === undefined ? {} : { text }),
  };
  const meta = parseMeta(match[2] ?? "", parseJson(match[3] ?? "{}"));
  return meta && ({ ...base, ...meta } as Entry);
}

function parseMeta(tag: string, json: unknown) {
  if (role.safeParse(tag).success) {
    const meta = messageMeta.safeParse(json);
    return meta.success
      ? { kind: "message", role: tag, ...meta.data }
      : undefined;
  }
  if (!Object.hasOwn(metas, tag)) return undefined;
  const meta = metas[tag as keyof typeof metas].safeParse(json);
  return meta.success ? { kind: tag, ...meta.data } : undefined;
}

function parseBody(body: string[]): string | undefined | null {
  const lines = body.filter((line, i) => line || i < body.length - 1);
  if (lines.some((line) => line && !line.startsWith(indent))) return null;
  return lines.length
    ? lines.map((line) => line.slice(indent.length)).join("\n")
    : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
