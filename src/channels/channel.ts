import type { MediaKind } from "../delivery/parts.ts";
import type { Env } from "../env.ts";
import type { AttachmentKind, Role } from "../record/chat-file.ts";
import type { OpenTools } from "../tools/mcp.ts";

export type IncomingMessage = {
  contact: string;
  ref: string;
  role: Role;
  sender?: string;
  at: Date;
  text?: string;
  attachments: {
    kind: AttachmentKind;
    source: string;
    name?: string;
    mime?: string;
  }[];
};

// A platform time in whole seconds: the message was sent in that second, and not after it arrived.
export function fromSeconds(seconds: number, receivedAt = Date.now()): Date {
  return new Date(Math.min(receivedAt, seconds * 1000 + 999));
}

export type Receiver = (
  connection: Connection,
  message: IncomingMessage,
) => Promise<void>;

export type Outgoing = { text: string } | { media: MediaKind; url: string };

export class SendError extends Error {
  constructor(
    message: string,
    readonly outcome: "temporary" | "refused" | "uncertain",
    readonly retryAfterMs = 1000,
  ) {
    super(message);
  }
}

export type HandoffCause = "out-of-scope" | "error";

export interface Connection {
  readonly id: string;
  readonly label: string;
  readonly maxTextLength: number;
  readonly media: ReadonlySet<MediaKind>;
  readonly routes: Record<string, (request: Request) => Promise<Response>>;
  readonly reconciled: Promise<void>;
  start(receive: Receiver): Promise<void>;
  stop(): Promise<void>;
  isAgentOwned(contact: string): Promise<boolean>;
  send(contact: string, message: Outgoing): Promise<string>;
  download(source: string): Promise<{ bytes: Uint8Array; mime?: string }>;
  typing?(contact: string): Promise<void>;
  note?(contact: string, text: string): Promise<void>;
  handoff?(contact: string, reason: string, cause: HandoffCause): Promise<void>;
  contactTools?(contact: string): Promise<OpenTools>;
}

export type ChannelFactory = (env: Env) => Promise<Connection[]>;
