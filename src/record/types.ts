export type ChatRef = { connectionId: string; chatId: string };

export type Author =
  | { role: "customer" }
  | { role: "operator"; id?: string; name?: string } // no id and no name = unknown attribution
  | { role: "workflow"; id?: string }
  | { role: "agent" };

export type AttachmentCategory =
  "image" | "document" | "audio" | "video" | "other";

export type Preparation =
  | { model: string; at: string; text: string }
  | { model: string; at: string; error: string };

export type Attachment = {
  id: string; // unique within the message, e.g. "a1"
  category: AttachmentCategory;
  source: string; // opaque adapter reference (respond.io URL, Telegram file_id). Never a URL with a secret.
  mediaType?: string;
  fileName?: string;
  size?: number;
  file?: string; // path relative to the chat folder after retrieval, e.g. "attachments/<msgId>-a1.jpg"
  retrievalError?: string;
  preparation?: Preparation;
};

export type Delivery =
  "observed" | "pending" | "sent" | "uncertain" | "failed" | "superseded";
// observed: inbound or outgoing traffic seen on the channel (customer/operator/workflow/agent echo without a local send)
// pending: agent part handed to the channel, outcome not known yet (becomes "uncertain" on restart)

export type ChatMessage = {
  id: string; // harness id (crypto.randomUUID())
  platformId?: string; // channel message id
  author: Author;
  sentAt: string; // original sent time on the channel; for agent parts: time of confirmed send
  text?: string;
  attachments: Attachment[];
  delivery: Delivery;
  turnId?: string;
  error?: string;
  mergedFromChatId?: string; // set on a message copied by a merge: the chat it came from
};

export type Owner = "agent" | "human" | "none";
export type TurnTrigger = "customer" | "review" | "nudge" | "nudge-retry";
export type TurnEnd =
  | "completed"
  | "skipped"
  | "superseded"
  | "failed"
  | "timed-out"
  | "interrupted";
export type NoteKind =
  | "nudge"
  | "nudge-failed"
  | "skip"
  | "handoff"
  | "error"
  | "expiry"
  | "info"
  | "operator";

export type EntryBody =
  | { type: "message"; message: ChatMessage }
  | {
      type: "message-update";
      messageId: string;
      delivery?: Delivery;
      platformId?: string;
      sentAt?: string;
      error?: string;
    }
  | {
      type: "attachment-update";
      messageId: string;
      attachmentId: string;
      file?: string;
      mediaType?: string;
      retrievalError?: string;
      preparation?: Preparation;
    }
  | { type: "ownership"; owner: Owner; assigneeId?: string; eventAt: string }
  | { type: "status"; open: boolean; eventAt: string }
  | {
      type: "note";
      by: "agent" | "system" | "operator";
      kind: NoteKind;
      text: string;
      turnId?: string;
    }
  | { type: "labels"; labels: string[] }
  | {
      type: "handoff";
      path: "tool" | "error" | "expiry";
      reason: string;
      turnId?: string;
    }
  | {
      type: "turn-start";
      turnId: string;
      trigger: TurnTrigger;
      inputThroughSeq: number;
      instructionsRevision: string;
    }
  | { type: "turn-end"; turnId: string; outcome: TurnEnd; reason?: string }
  | {
      type: "tool-call";
      turnId: string;
      callId: string;
      name: string;
      input: unknown;
    }
  | {
      type: "tool-result";
      turnId: string;
      callId: string;
      name: string;
      output: unknown;
      isError: boolean;
    }
  | { type: "trigger"; turnId: string; text: string } // artificial nudge prompt (user-side, internal)
  | { type: "merge"; fromChatId: string }; // history of fromChatId was merged into this chat

export type Entry = EntryBody & { seq: number; at: string; eventId?: string };
// seq: per-chat append counter starting at 1. at: recording time. eventId: channel notification id for dedupe.
