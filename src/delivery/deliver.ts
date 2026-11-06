import { setTimeout as sleep } from "node:timers/promises";

import { type Channel, SendError } from "../channels/channel.ts";
import { errorText, log } from "../log.ts";
import type { MessageEntry } from "../record/entries.ts";
import type { Chat } from "../record/store.ts";
import { type Outgoing, planPart, type VideoPolicy } from "./plan.ts";

export interface DeliveryPolicy {
  pacing: "typing" | "none";
  secondsPerWord: number;
  video: VideoPolicy;
}

export interface DeliveryOutcome {
  delivered: number;
  unsent: string[];
  failure?: "failed" | "uncertain";
}

/** Sends parts in order, one at a time, without blocking generation. */
export class Delivery {
  private chain = Promise.resolve();
  private parts = 0;
  private readonly outcome: DeliveryOutcome = { delivered: 0, unsent: [] };

  constructor(
    private readonly channel: Channel,
    private readonly chat: Chat,
    private readonly turn: string,
    private readonly policy: DeliveryPolicy,
    private readonly signal: AbortSignal,
  ) {}

  push(part: string) {
    const first = this.parts++ === 0;
    this.chain = this.chain.then(() => this.deliver(part, first));
  }

  async finish(): Promise<DeliveryOutcome> {
    await this.chain;
    return this.outcome;
  }

  private async deliver(part: string, first: boolean) {
    if (this.signal.aborted || this.outcome.failure) {
      this.outcome.unsent.push(part);
      return;
    }
    try {
      if (!first) await this.pace(part);
    } catch {
      this.outcome.unsent.push(part);
      return;
    }
    const items = planPart(part, this.policy.video, {
      textLimit: this.channel.textLimit,
      sendsVideo: this.channel.sendVideo !== undefined,
    });
    for (const item of items) if (!(await this.send(item))) return;
    this.outcome.delivered++;
  }

  private async pace(part: string) {
    if (this.policy.pacing === "none") return;
    const ms = part.split(/\s+/).length * this.policy.secondsPerWord * 1000;
    const typing = this.channel.showTyping?.bind(this.channel);
    const end = Date.now() + ms;
    while (Date.now() < end) {
      typing?.(this.chat.id).catch(() => {});
      await sleep(Math.min(4000, end - Date.now()), undefined, {
        signal: this.signal,
      });
    }
  }

  private async send(item: Outgoing): Promise<boolean> {
    const text = item.kind === "text" ? item.text : item.url;
    const entry = await this.chat.add({
      type: "message",
      at: new Date().toISOString(),
      role: "agent",
      text,
      delivery: "sending",
      turn: this.turn,
      ...(item.kind === "video" && { video: true }),
    });
    try {
      const ref = await this.attempt(item);
      await this.chat.update<MessageEntry>(entry, { delivery: "sent", ref });
      log.info("delivery.sent", {
        conversation: this.chat.id,
        turn: this.turn,
        ref,
      });
      return true;
    } catch (error) {
      const failure =
        error instanceof SendError && error.failure !== "uncertain"
          ? "failed"
          : "uncertain";
      this.outcome.failure = failure;
      await this.chat.update<MessageEntry>(entry, { delivery: failure });
      log.warn("delivery.stopped", {
        conversation: this.chat.id,
        turn: this.turn,
        failure,
        error: errorText(error),
      });
      return false;
    }
  }

  private async attempt(item: Outgoing, tries = 3): Promise<string> {
    const conversation = this.chat.id;
    try {
      return item.kind === "video" && this.channel.sendVideo
        ? await this.channel.sendVideo(conversation, item.url)
        : await this.channel.sendText(
            conversation,
            item.kind === "text" ? item.text : item.url,
          );
    } catch (error) {
      if (
        !(error instanceof SendError && error.failure === "rejected") ||
        tries <= 1
      )
        throw error;
      await Bun.sleep(Math.min(error.retryAfterMs, 10_000));
      return this.attempt(item, tries - 1);
    }
  }
}
