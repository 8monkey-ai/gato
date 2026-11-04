import type { EnvReader } from "../config/env.ts";
import type { Logger } from "../log.ts";
import type { Attachment, Author, Owner } from "../record/types.ts";
import type { AgentTool } from "../tools/tool.ts";

export type InboundAttachment = Omit<
  Attachment,
  "id" | "file" | "retrievalError" | "preparation"
>;
export type InboundMessage = {
  platformId: string;
  author: Author;
  sentAt: Date;
  text?: string;
  attachments: InboundAttachment[];
};
export type InboundEvent =
  | {
      kind: "message";
      chatId: string;
      eventId: string;
      message: InboundMessage;
    }
  | {
      kind: "ownership";
      chatId: string;
      eventId: string;
      at: Date;
      owner: Owner;
      assigneeId?: string;
    }
  | {
      kind: "status";
      chatId: string;
      eventId: string;
      at: Date;
      open: boolean;
    };
// Resolves after the event is saved durably.
export type InboundSink = (event: InboundEvent) => Promise<void>;

export type OutboundPart =
  { kind: "text"; text: string } | { kind: "video"; url: string };
export type SendOutcome =
  | { status: "sent"; platformId?: string; sentAt: Date }
  | { status: "uncertain"; error: string } // never resent
  | { status: "failed"; error: string; retryAfterMs?: number }; // retryAfterMs set = not accepted, safe to retry

export type ChannelConnection = {
  id: string;
  maxTextLength: number;
  supportsVideo: boolean;
  routes?: Record<string, (request: Request) => Promise<Response>>; // path -> handler, mounted by server/http.ts
  start(sink: InboundSink): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, part: OutboundPart): Promise<SendOutcome>;
  fetchAttachment(
    source: string,
  ): Promise<{ bytes: Uint8Array; mediaType?: string }>;
  // Optional native capabilities. Absence means the core uses the chat-folder fallback.
  typing?(chatId: string): Promise<void>;
  assignment?: {
    fetchState(
      chatId: string,
    ): Promise<{ owner: Owner; assigneeId?: string; open: boolean }>;
  };
  notes?: { add(chatId: string, text: string): Promise<void> };
  labels?: {
    add(chatId: string, labels: string[]): Promise<void>;
    read(chatId: string): Promise<string[]>;
  };
  notifyOperators?(chatId: string, text: string): Promise<void>;
  // Private facts about the customer for the prompt, such as name and language. Never internal ids.
  contactContext?(chatId: string): Promise<Record<string, string>>;
  contactTools?(chatId: string): Promise<AgentTool[]>; // provider tools scoped to this contact
};

export type ChannelType = {
  type: string; // value of GATO_CONNECTION_<ID>_TYPE
  create(id: string, env: EnvReader, log: Logger): Promise<ChannelConnection>; // reads its own scoped env
};
