export type Role = "customer" | "operator" | "workflow" | "agent";

export type Category = "image" | "document" | "audio" | "video" | "other";

export type Delivery = "sending" | "sent" | "failed" | "uncertain";

export type TurnStatus =
  | "running"
  | "completed"
  | "skipped"
  | "superseded"
  | "failed"
  | "timed-out"
  | "interrupted";

export interface Attachment {
  category: Category;
  name?: string;
  mime?: string;
  /** Adapter reference that downloads the original file. */
  source?: string;
  /** Path of the stored original, relative to the chat folder. */
  file?: string;
  retrievalError?: string;
  prepared?: { text: string; model: string };
}

export interface MessageEntry {
  type: "message";
  id: string;
  at: string;
  role: Role;
  /** Display name of the sender. Absent when the platform does not establish it. */
  sender?: string;
  text: string;
  attachments?: Attachment[];
  /** Platform message identifier. */
  ref?: string;
  /** The message arrived while ownership permitted a reply. */
  trigger?: boolean;
  delivery?: Delivery;
  turn?: string;
  video?: boolean;
}

type NoteKind =
  "nudge" | "nudge-failed" | "handoff" | "error" | "skip" | "diagnostic";

export interface NoteEntry {
  type: "note";
  id: string;
  at: string;
  author: "agent" | "harness";
  kind: NoteKind;
  text: string;
  turn?: string;
}

interface ToolEntry {
  type: "tool";
  id: string;
  at: string;
  turn: string;
  name: string;
  input: unknown;
  output?: unknown;
  error?: string;
}

export interface TurnEntry {
  type: "turn";
  id: string;
  at: string;
  trigger: "customer" | "nudge";
  status: TurnStatus;
  /** Customer messages that this turn answers. */
  covers: string[];
  endedAt?: string;
  reason?: string;
  /** Generated text that did not reach the customer. */
  unsent?: string;
}

export type Entry = MessageEntry | NoteEntry | ToolEntry | TurnEntry;

export type NewEntry =
  | Omit<MessageEntry, "id">
  | Omit<NoteEntry, "id">
  | Omit<ToolEntry, "id">
  | Omit<TurnEntry, "id">;
