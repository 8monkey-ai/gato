import type { Channel, ChannelSink } from "../channels/channel.ts";
import { errorText, log } from "../log.ts";
import { pendingMessages } from "../record/activity.ts";
import type { Chat, ChatStore } from "../record/store.ts";
import { recordIncoming, settleAfterRestart } from "./incoming.ts";
import { runTurn, type TurnDeps } from "./turn.ts";

interface ConversationState {
  busy: boolean;
  done: Promise<void>;
  running?: AbortController;
}

/** Runs at most one turn per conversation. Conversations progress independently. */
export class Conversations {
  private readonly states = new Map<Chat, ConversationState>();
  private stopping = false;

  constructor(
    private readonly store: ChatStore,
    private readonly deps: TurnDeps,
  ) {}

  sink(channel: Channel): ChannelSink {
    return {
      receive: async (conversation, message) => {
        const chat = this.store.chat(channel.name, conversation);
        const customerInput = await recordIncoming(chat, message);
        log.info("message.recorded", {
          conversation,
          channel: channel.name,
          ref: message.ref,
          role: message.role,
        });
        if (!customerInput) return;
        this.state(chat).running?.abort("new customer message");
        void this.start(channel, chat, { checkOwnership: false });
      },
    };
  }

  /** Settles work that a restart abandoned, then answers what still waits, if the agent owns it. */
  async resume(channels: Channel[]) {
    for (const chat of this.store.all()) {
      await settleAfterRestart(chat);
      const channel = channels.find((c) => c.name === chat.connection);
      if (channel && pendingMessages(chat.entries).length)
        void this.start(channel, chat, { checkOwnership: true });
    }
  }

  isIdle(chat: Chat): boolean {
    return !this.state(chat).busy;
  }

  /** Runs the nudge when the conversation is idle and the check still passes. */
  nudge(
    channel: Channel,
    chat: Chat,
    check: () => Promise<boolean>,
  ): Promise<void> | undefined {
    return this.start(channel, chat, { checkOwnership: false, nudge: check });
  }

  async shutdown(timeoutMs: number) {
    this.stopping = true;
    const all = () => Promise.all([...this.states.values()].map((s) => s.done));
    const finished = await Promise.race([
      all().then(() => true),
      Bun.sleep(timeoutMs).then(() => false),
    ]);
    if (!finished)
      for (const state of this.states.values())
        state.running?.abort("shutdown");
    await all();
    await Promise.all(this.store.all().map((chat) => chat.flush()));
  }

  private state(chat: Chat): ConversationState {
    let state = this.states.get(chat);
    if (!state) {
      state = { busy: false, done: Promise.resolve() };
      this.states.set(chat, state);
    }
    return state;
  }

  private start(
    channel: Channel,
    chat: Chat,
    options: { checkOwnership: boolean; nudge?: () => Promise<boolean> },
  ): Promise<void> | undefined {
    const state = this.state(chat);
    if (state.busy || this.stopping) return undefined;
    state.busy = true;
    state.done = (async () => {
      try {
        if (options.nudge && (await options.nudge()))
          await this.turn(channel, chat, "nudge", []);
        await this.answerPending(channel, chat, options.checkOwnership);
      } catch (error) {
        log.error("conversation.failed", {
          conversation: chat.id,
          error: errorText(error),
        });
      } finally {
        state.busy = false;
      }
    })();
    return state.done;
  }

  private async answerPending(
    channel: Channel,
    chat: Chat,
    checkOwnership: boolean,
  ) {
    let check = checkOwnership;
    while (!this.stopping) {
      const pending = pendingMessages(chat.entries);
      if (!pending.length) return;
      if (check && !(await channel.agentOwns(chat.id))) return;
      check = false;
      await this.turn(
        channel,
        chat,
        "customer",
        pending.map((message) => message.id),
      );
    }
  }

  private async turn(
    channel: Channel,
    chat: Chat,
    trigger: "customer" | "nudge",
    covers: string[],
  ) {
    const state = this.state(chat);
    const controller = new AbortController();
    state.running = controller;
    try {
      await runTurn(this.deps, {
        chat,
        channel,
        trigger,
        covers,
        interrupt: controller.signal,
      });
    } finally {
      state.running = undefined;
    }
  }
}
