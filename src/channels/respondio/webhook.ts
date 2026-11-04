import type { Logger } from "../../log.ts";
import type { InboundSink } from "../channel.ts";
import { mapPayload } from "./mapping.ts";
import { hasValidSignature } from "./signature.ts";

type WebhookOptions = {
  signingKeys: string[];
  agentUserId: string;
  sink: () => InboundSink | undefined;
  log: Logger;
  now: () => Date;
};

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
}

export function webhookHandler(options: WebhookOptions) {
  const { signingKeys, agentUserId, log, now } = options;
  return async (request: Request): Promise<Response> => {
    const body = await request.bytes();
    const signature = request.headers.get("X-Webhook-Signature");
    if (!hasValidSignature(body, signature, signingKeys))
      return new Response("Invalid signature", { status: 401 });
    const sink = options.sink();
    if (!sink) return new Response("Not started", { status: 503 });
    const json = parseJson(body);
    const result =
      json === undefined
        ? { malformed: "invalid JSON" }
        : mapPayload(json, { agentUserId, receivedAt: now() });
    if ("malformed" in result) {
      log.warn("respondio_malformed_webhook", { reason: result.malformed });
      return new Response("OK");
    }
    if ("ignore" in result) return new Response("OK");
    try {
      await sink(result);
      return new Response("OK");
    } catch (error) {
      log.error("respondio_ingest_failed", { eventId: result.eventId, error });
      return new Response("Ingest failed", { status: 500 });
    }
  };
}
