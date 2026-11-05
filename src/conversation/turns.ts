import { sleep } from "../delivery/outbox.ts";
import { errorText, log } from "../log.ts";
import { logFields } from "./store.ts";
import type { Conversation } from "./store.ts";

export type TurnKind = "reply" | "review" | "nudge";

export type TurnRunner = (
  conversation: Conversation,
  kind: TurnKind,
  signal: AbortSignal,
) => Promise<void>;

export class TurnStop extends Error {
  constructor(readonly reason: "interrupt" | "shutdown") {
    super(`Turn stopped: ${reason}`);
  }
}

interface Running {
  controller: AbortController;
  done: Promise<void>;
}

async function stopAll(running: Map<Conversation, Running>, graceMs: number) {
  const finished = Promise.all([...running.values()].map((turn) => turn.done));
  const inTime = await Promise.race([
    finished.then(() => true),
    sleep(graceMs).then(() => false),
  ]);
  if (inTime) return;
  for (const turn of running.values()) {
    turn.controller.abort(new TurnStop("shutdown"));
  }
  await finished;
}

export function createTurns(
  runner: TurnRunner,
  eligible: (conversation: Conversation) => boolean,
) {
  const running = new Map<Conversation, Running>();
  const queued = new Map<Conversation, TurnKind>();
  let accepting = true;

  async function run(conversation: Conversation, kind: TurnKind) {
    const controller = new AbortController();
    const done = runner(conversation, kind, controller.signal).catch(
      (error: unknown) =>
        log("error", "turn.crashed", {
          ...logFields(conversation),
          error: errorText(error),
        }),
    );
    running.set(conversation, { controller, done });
    await done;
    running.delete(conversation);
  }

  async function drain(conversation: Conversation) {
    for (
      let kind = queued.get(conversation);
      kind && accepting;
      kind = queued.get(conversation)
    ) {
      queued.delete(conversation);
      if (eligible(conversation)) await run(conversation, kind);
    }
  }

  return {
    request(conversation: Conversation, kind: TurnKind) {
      if (!accepting) return;
      const current = queued.get(conversation);
      queued.set(conversation, current && kind === "nudge" ? current : kind);
      if (!running.has(conversation)) void drain(conversation);
    },
    interrupt(conversation: Conversation) {
      running.get(conversation)?.controller.abort(new TurnStop("interrupt"));
    },
    isBusy: (conversation: Conversation) =>
      running.has(conversation) || queued.has(conversation),
    async stop(graceMs: number) {
      accepting = false;
      queued.clear();
      await stopAll(running, graceMs);
    },
  };
}
