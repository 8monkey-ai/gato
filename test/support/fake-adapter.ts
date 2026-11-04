import { z } from "zod";

import type {
  ChannelAdapter,
  ChannelCapabilities,
} from "../../src/channel/adapter.ts";
import type { InboundEvent, InboundSink } from "../../src/channel/inbound.ts";
import type { ChannelRegistration } from "../../src/channel/registry.ts";

/** Receives inbound events as JSON at `POST /<kind>/<connection>` and answers with the result. */
export class FakeAdapter implements ChannelAdapter {
  readonly capabilities: ChannelCapabilities = {
    maxTextLength: 4096,
    formatting: "plain",
    videoByUrl: false,
    operatorMessageEvents: false,
  };
  #sink: InboundSink | undefined;

  constructor(
    readonly kind: string,
    readonly connection: string,
  ) {}

  routes() {
    return [
      {
        method: "POST" as const,
        path: "",
        handle: async (request: Request) => {
          if (!this.#sink) return new Response("Not started", { status: 503 });
          const event = (await request.json()) as InboundEvent;
          return new Response(await this.#sink.accept(event));
        },
      },
    ];
  }

  start(sink: InboundSink) {
    this.#sink = sink;
    return Promise.resolve();
  }

  stop() {
    this.#sink = undefined;
    return Promise.resolve();
  }

  send() {
    return Promise.resolve({ status: "sent" as const, externalId: "fake" });
  }
}

export function fakeRegistration(
  kind: string,
  envVar: string,
): ChannelRegistration<{ token: string }> {
  return {
    kind,
    envVar,
    schema: z.object({ token: z.string().min(1) }),
    create: (name) => new FakeAdapter(kind, name),
  };
}
