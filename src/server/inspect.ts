import type { Controls } from "../conversation/controls.ts";
import type { ChatStore } from "../storage/chat-store.ts";

export async function inspectChats(deps: {
  store: Pick<ChatStore, "list" | "isDamaged">;
  controls: Pick<Controls, "state">;
}) {
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
        damaged: deps.store.isDamaged(ref),
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
