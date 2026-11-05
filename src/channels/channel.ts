import type { ToolSet } from "ai";

import type { Env } from "../config/env.ts";
import type {
  AttachmentCategory,
  Ownership,
  Role,
  Sender,
} from "../conversation/entry.ts";

export interface IncomingAttachment {
  category: AttachmentCategory;
  source: string;
  mediaType?: string;
  name?: string;
  size?: number;
  description?: string;
}

export function categoryOf(
  mediaType: string | undefined,
): IncomingAttachment["category"] {
  const top = mediaType?.split("/")[0];
  return top === "image" || top === "audio" || top === "video"
    ? top
    : "document";
}

export interface ChannelMessage {
  ref: string;
  at: Date;
  role: Role;
  text?: string;
  attachments?: IncomingAttachment[];
  sender?: Sender;
}

export interface ChatEvent {
  chat: string;
  message?: ChannelMessage;
  ownership?: Partial<Ownership>;
  profile?: Record<string, string>;
  labels?: { add?: string[]; remove?: string[] };
}

export interface Inbox {
  handle(event: ChatEvent): Promise<void>;
  fail(error: unknown): void;
}

export type OutgoingPart = { text: string } | { videoUrl: string };

export type SendResult =
  | { status: "sent"; ref?: string }
  | { status: "rejected"; reason: string }
  | { status: "uncertain"; reason: string }
  | { status: "retry"; afterMs: number };

export type RouteHandler = (request: Request) => Promise<Response>;

export interface Channel {
  readonly maxMessageLength: number;
  readonly nativeAssignment: boolean;
  readonly videoAttachments: boolean;
  readonly routes: Record<string, RouteHandler>;
  start(inbox: Inbox): Promise<void>;
  stop(): Promise<void>;
  send(chat: string, part: OutgoingPart): Promise<SendResult>;
  retrieve(source: string): Promise<{ data: Uint8Array; mediaType?: string }>;
  typing?(chat: string): Promise<void>;
  notes?: { add(chat: string, text: string): Promise<void> };
  labels?: {
    add(chat: string, labels: string[]): Promise<void>;
    list(chat: string): Promise<string[]>;
  };
  notifyOperators?(chat: string, text: string): Promise<void>;
  reconcile?(chat: string): Promise<ChatEvent>;
  tools?(chat: string): Promise<ToolSet>;
}

type ChannelFactory = (name: string, env: Env) => Channel;

const factories = new Map<string, ChannelFactory>();

export function registerChannelType(type: string, factory: ChannelFactory) {
  factories.set(type, factory);
}

export function createChannel(type: string, name: string, env: Env) {
  const factory = factories.get(type);
  if (!factory) {
    throw new Error(
      `Unknown channel type "${type}" for connection "${name}". Use one of: ${[...factories.keys()].join(", ")}.`,
    );
  }
  return factory(name, env);
}
