import type { Category, Role } from "../record/entries.ts";

export interface IncomingAttachment {
  category: Category;
  name?: string;
  mime?: string;
  /** Opaque reference that the same adapter downloads later. */
  source: string;
}

export interface IncomingMessage {
  /** Platform message identifier, used to drop repeated notifications. */
  ref: string;
  at: Date;
  role: Role;
  sender?: string;
  text: string;
  attachments: IncomingAttachment[];
  /** True for a customer message that arrived while the agent may answer. */
  answerable: boolean;
}

export interface ChannelSink {
  /** Resolves after the message is stored, so the adapter can acknowledge it. */
  receive(conversation: string, message: IncomingMessage): Promise<void>;
}

export type SendFailure = "failed" | "uncertain" | "rejected";

/** "rejected": the platform refused the request and did not act, so a retry cannot duplicate it. */
export class SendError extends Error {
  constructor(
    readonly failure: SendFailure,
    message: string,
    readonly retryAfterMs = 1000,
  ) {
    super(message);
  }
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export type HandoffReason = "out-of-scope" | "error";

/** Optional members are channel features. Callers use the fallbacks of SPECS.md when one is absent. */
export interface Channel {
  readonly name: string;
  readonly textLimit: number;
  readonly routes: Record<string, (request: Request) => Promise<Response>>;
  start(sink: ChannelSink): Promise<void>;
  stop(): Promise<void>;
  /** On a channel without assignment, every conversation is agent-owned. */
  agentOwns(conversation: string): Promise<boolean>;
  download(source: string): Promise<{ data: Uint8Array; mime?: string }>;
  /** Returns the platform message identifier. Throws SendError. */
  sendText(conversation: string, text: string): Promise<string>;
  sendVideo?(conversation: string, url: string): Promise<string>;
  showTyping?(conversation: string): Promise<void>;
  addNote?(conversation: string, text: string): Promise<void>;
  handOff?(conversation: string, reason: HandoffReason): Promise<void>;
  tools?(conversation: string): AgentTool[];
}

export interface ChannelFactory {
  name: string;
  create(env: Record<string, string | undefined>): Channel;
}

const factories = new Map<string, ChannelFactory>();

export function registerChannel(factory: ChannelFactory) {
  factories.set(factory.name, factory);
}

/** Creates the channels that the operator enabled, in the order given. */
export function createChannels(
  names: string[],
  env: Record<string, string | undefined>,
): Channel[] {
  return names.map((name) => {
    const factory = factories.get(name);
    if (!factory)
      throw new Error(
        `CHANNELS: unknown channel "${name}". Available: ${[...factories.keys()].join(", ")}`,
      );
    return factory.create(env);
  });
}
