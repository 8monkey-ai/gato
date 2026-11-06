import { verifySignature } from "@8monkey/aikit-respond-io/webhook";
import { RespondIO, RespondIOError } from "@respond-io/typescript-sdk";

import { errorText, log } from "../../log.ts";
import { McpConnection } from "../../mcp/connection.ts";
import {
  type AgentTool,
  type Channel,
  type ChannelSink,
  type HandoffReason,
  registerChannel,
  SendError,
} from "../channel.ts";
import { readRespondioSettings, type RespondioSettings } from "./settings.ts";
import { checkContactScope, contactTools } from "./tools.ts";
import { parseWebhook } from "./webhook.ts";

function sendError(error: unknown): SendError {
  if (
    !(error instanceof RespondIOError) ||
    error.statusCode === 0 ||
    error.statusCode >= 500
  )
    return new SendError("uncertain", errorText(error));
  if (error.statusCode === 429)
    return new SendError(
      "rejected",
      error.message,
      (error.rateLimitInfo?.retryAfter ?? 1) * 1000,
    );
  return new SendError("failed", error.message);
}

class RespondioChannel implements Channel {
  readonly name = "respondio";
  readonly textLimit = 4096;
  readonly routes: Channel["routes"];
  private readonly api: RespondIO;
  private sink?: ChannelSink;
  private mcp?: McpConnection;

  constructor(private readonly settings: RespondioSettings) {
    // One attempt only: the SDK would otherwise resend after network errors and duplicate messages.
    this.api = new RespondIO({
      apiToken: settings.apiToken,
      baseUrl: settings.apiBaseUrl,
      maxRetries: 1,
      timeout: 20_000,
    });
    this.routes = { "/respondio/webhook": (request) => this.webhook(request) };
  }

  async start(sink: ChannelSink) {
    await this.api.space.getUser(this.settings.agentUserId);
    const mcp = this.settings.mcp;
    if (mcp) {
      this.mcp = await McpConnection.connect({
        server: "respondio",
        url: mcp.url,
        headers: { Authorization: `Bearer ${mcp.token}` },
        permitted: mcp.tools,
      });
      checkContactScope(this.mcp);
    }
    this.sink = sink;
  }

  async stop() {
    this.sink = undefined;
    await this.mcp?.close();
  }

  private async webhook(request: Request): Promise<Response> {
    const body = await request.text();
    try {
      verifySignature(
        body,
        request.headers.get("x-webhook-signature") ?? "",
        this.settings.signingKey,
      );
    } catch {
      log.warn("respondio.webhook_unauthorized");
      return new Response("Unauthorized", { status: 401 });
    }
    if (!this.sink) return new Response("Not ready", { status: 503 });
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      json = undefined;
    }
    const event = parseWebhook(json, this.settings.agentUserId);
    if (event.kind === "malformed")
      log.warn("respondio.webhook_malformed", { problem: event.problem });
    if (event.kind !== "message") return new Response("OK");
    try {
      await this.sink.receive(event.contact, event.message);
      return new Response("OK");
    } catch (error) {
      log.error("respondio.webhook_not_stored", {
        contact: event.contact,
        error: errorText(error),
      });
      return new Response("Not stored", { status: 500 });
    }
  }

  async agentOwns(conversation: string) {
    const contact = await this.api.contacts.get(`id:${Number(conversation)}`);
    return (
      !contact.assignee || contact.assignee.id === this.settings.agentUserId
    );
  }

  async download(source: string) {
    const response = await fetch(source, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok)
      throw new Error(`attachment download answered ${response.status}`);
    return {
      data: await response.bytes(),
      mime: response.headers.get("content-type") ?? undefined,
    };
  }

  private async send(
    conversation: string,
    message: Parameters<RespondIO["messaging"]["send"]>[1]["message"],
  ) {
    try {
      const result = await this.api.messaging.send(
        `id:${Number(conversation)}`,
        {
          channelId: this.settings.replyChannelId ?? null,
          message,
        },
      );
      return String(result.messageId);
    } catch (error) {
      throw sendError(error);
    }
  }

  sendText(conversation: string, text: string) {
    return this.send(conversation, { type: "text", text });
  }

  sendVideo(conversation: string, url: string) {
    return this.send(conversation, {
      type: "attachment",
      attachment: { type: "video", url },
    });
  }

  async addNote(conversation: string, text: string) {
    await this.api.comments.create(`id:${Number(conversation)}`, {
      text: text.slice(0, 1000),
    });
  }

  async handOff(conversation: string, reason: HandoffReason) {
    const labels = this.settings.labels;
    const reasonLabel = reason === "error" ? labels.error : labels.outOfScope;
    await this.api.contacts.addTags(`id:${Number(conversation)}`, [
      labels.handoff,
      reasonLabel,
    ]);
  }

  tools(conversation: string): AgentTool[] {
    const mcp = this.settings.mcp;
    return this.mcp && mcp ? contactTools(this.mcp, conversation, mcp) : [];
  }
}

registerChannel({
  name: "respondio",
  create: (env) => new RespondioChannel(readRespondioSettings(env)),
});
