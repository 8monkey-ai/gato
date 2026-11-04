import type { Controls } from "../conversation/controls.ts";
import { chatKey } from "../nudges/chats.ts";
import type { ChatStore } from "../storage/chat-store.ts";

export async function inspectChats(deps: {
  store: Pick<ChatStore, "list" | "damaged">;
  controls: Pick<Controls, "state">;
}) {
  const damaged = new Set(deps.store.damaged().map((d) => chatKey(d.ref)));
  return Promise.all(
    deps.store.list().map(async (ref) => {
      const { owner, open, view } = await deps.controls.state(ref);
      const agentParts = view.messages.filter((m) => m.author.role === "agent");
      const count = (delivery: string) =>
        agentParts.filter((m) => m.delivery === delivery).length;
      const turn = view.turns.at(-1);
      return {
        ...ref,
        owner,
        open,
        pendingInput: view.hasPendingInput,
        damaged: damaged.has(chatKey(ref)),
        latestTurn: turn && {
          trigger: turn.trigger,
          startedAt: turn.startedAt,
          outcome: turn.end?.outcome ?? "running",
        },
        agentParts: {
          failed: count("failed"),
          pending: count("pending"),
          uncertain: count("uncertain"),
        },
      };
    }),
  );
}
