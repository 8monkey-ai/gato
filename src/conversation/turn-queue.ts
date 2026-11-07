import type { Connection } from "../channels/channel.ts";
import { log } from "../log.ts";
import type { Trigger } from "../record/chat-file.ts";
import type { Conversation } from "../record/store.ts";

export type RunTurn = (
  conversation: Conversation,
  connection: Connection,
  trigger: Trigger,
  interruption: AbortSignal,
) => Promise<void>;

type State = {
  wanted?: Trigger;
  controller?: AbortController;
  running?: Promise<void>;
};

export function createTurnQueue(runTurn: RunTurn) {
  const states = new Map<Conversation, State>();
  const control = { stopping: false };

  const request = (
    conversation: Conversation,
    connection: Connection,
    trigger: Trigger,
  ) => {
    const state = states.get(conversation) ?? {};
    states.set(conversation, state);
    const busy = state.running || state.wanted;
    if (control.stopping || (trigger === "nudge" && busy)) return;
    if (trigger === "customer" || !state.wanted) state.wanted = trigger;
    state.running ??= drain(runTurn, conversation, connection, state, control);
  };

  const stop = async (graceMs: number) => {
    control.stopping = true;
    const timer = setTimeout(() => {
      for (const state of states.values()) state.controller?.abort("shutdown");
    }, graceMs);
    await Promise.all([...states.values()].flatMap((s) => s.running ?? []));
    clearTimeout(timer);
  };

  return {
    request,
    stop,
    interrupt: (conversation: Conversation) =>
      states.get(conversation)?.controller?.abort("interrupted"),
    isBusy: (conversation: Conversation) => !!states.get(conversation)?.running,
  };
}

async function drain(
  runTurn: RunTurn,
  conversation: Conversation,
  connection: Connection,
  state: State,
  control: { stopping: boolean },
) {
  while (state.wanted && !control.stopping) {
    const trigger = state.wanted;
    state.wanted = undefined;
    state.controller = new AbortController();
    await runTurn(
      conversation,
      connection,
      trigger,
      state.controller.signal,
    ).catch((error: unknown) => {
      const where = {
        connection: connection.id,
        contact: conversation.contact,
      };
      log.error("turn.crashed", { ...where, error });
    });
  }
  state.running = undefined;
  state.controller = undefined;
}
