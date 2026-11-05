export type Role = "customer" | "operator" | "workflow" | "agent";

export type Delivery = "sending" | "sent" | "uncertain" | "failed";

export type AttachmentCategory =
  "image" | "document" | "audio" | "video" | "other";

export type Sender = { id?: string; name?: string } | "unknown";

export interface Attachment {
  id: string;
  category: AttachmentCategory;
  source: string;
  mediaType?: string;
  name?: string;
  size?: number;
  description?: string;
  file?: string;
  retrievalError?: string;
  prepared?: { model: string; text: string; at: string };
}

interface Base {
  id: string;
  at: string;
  turn?: string;
}

export interface MessageEntry extends Base {
  kind: "message";
  role: Role;
  ref?: string;
  text?: string;
  attachments?: Attachment[];
  sender?: Sender;
  delivery?: Delivery;
}

export interface ToolCallEntry extends Base {
  kind: "tool-call";
  callId: string;
  tool: string;
  input: unknown;
}

export interface ToolResultEntry extends Base {
  kind: "tool-result";
  callId: string;
  tool: string;
  output: unknown;
  error?: boolean;
}

export type NoteType =
  | "nudge"
  | "nudge-failed"
  | "handoff"
  | "error"
  | "expired"
  | "skip"
  | "outcome"
  | "draft"
  | "diagnostic";

export interface NoteEntry extends Base {
  kind: "note";
  type: NoteType;
  text: string;
  byAgent?: boolean;
}

export interface TriggerEntry extends Base {
  kind: "trigger";
  text: string;
}

export type Entry =
  MessageEntry | ToolCallEntry | ToolResultEntry | NoteEntry | TriggerEntry;

export type Assignee = "agent" | "human" | "none";

export interface Ownership {
  assignee: Assignee;
  open: boolean;
}

export interface ChatState extends Ownership {
  labels: string[];
  profile: Record<string, string>;
  pendingReply: boolean;
  activeTurn?: string;
  expiredFor?: string;
}

export function initialState(): ChatState {
  return {
    assignee: "agent",
    open: true,
    labels: [],
    profile: {},
    pendingReply: false,
  };
}

type Kind = Entry["kind"];

export type EntryInput = {
  [K in Kind]: Omit<Extract<Entry, { kind: K }>, "id" | "at" | "turn">;
}[Kind];
