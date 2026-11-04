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

/** One connection of one channel kind. */
export interface ChannelAdapter {
  readonly kind: string;
  readonly connection: string;
  readonly capabilities: ChannelCapabilities;
  routes(): HttpRoute[];
  start(sink: InboundSink): Promise<void>;
  stop(): Promise<void>;
}

/** What the application gives an adapter. */
export interface AdapterHost {
  logger: Logger;
}
