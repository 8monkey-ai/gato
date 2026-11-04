import type { ChatRef } from "../conversation/state.ts";
import type { Logger } from "../log/logger.ts";
import type { InboundSink } from "./inbound.ts";

/** What the platform supports. Missing features use the fallbacks, not errors. */
export interface ChannelCapabilities {
  maxTextLength: number;
  formatting: "plain" | "markdown";
  videoByUrl: boolean;
  operatorMessageEvents: boolean;
}

export interface HttpRoute {
  method: "GET" | "POST";
  /** Added to `/<kind>/<connection>`; "" is that path. */
  path: string;
  handle(request: Request): Response | Promise<Response>;
}

/** Where the HTTP server mounts the routes of a connection. */
export function connectionPath(
  adapter: Pick<ChannelAdapter, "kind" | "connection">,
): string {
  return `/${adapter.kind}/${adapter.connection}`;
}

export interface OutboundPart {
  kind: "text";
  text: string;
}

/**
 * `rejected`: the platform did not take the part, so a new send cannot duplicate it.
 * `uncertain`: the part may have arrived; never send it again.
 */
export type SendResult =
  | { status: "sent"; externalId: string }
  | { status: "rejected"; permanent: boolean; retryAfterMs?: number }
  | { status: "uncertain" };

/** One connection of one channel kind. */
export interface ChannelAdapter {
  readonly kind: string;
  readonly connection: string;
  readonly capabilities: ChannelCapabilities;
  routes(): HttpRoute[];
  start(sink: InboundSink): Promise<void>;
  stop(): Promise<void>;
  send(chat: ChatRef, part: OutboundPart): Promise<SendResult>;
}

/** What the application gives an adapter. */
export interface AdapterHost {
  logger: Logger;
}
