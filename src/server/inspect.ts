import type { Controls } from "../conversation/controls.ts";
import { expiredAt } from "../nudges/policy.ts";
import type { ChatView } from "../record/projection.ts";
import type { NoteKind } from "../record/types.ts";
import type { ChatStore } from "../storage/chat-store.ts";

const latestNoteAt = (view: ChatView, kind: NoteKind) =>
  view.notes.filter((n) => n.kind === kind).at(-1)?.at;

// An overview for operators: states and times only, never message texts.
export async function inspectChats(deps: {
  store: Pick<ChatStore, "list" | "isDamaged">;
  controls: Pick<Controls, "state">;
}) {
  return Promise.all(
    deps.store.list().map(async (ref) => {
      const { owner, open, paused, view } = await deps.controls.state(ref);
      const agentParts = view.messages.filter((m) => m.author.role === "agent");
      const count = (delivery: string) =>
        agentParts.filter((m) => m.delivery === delivery).length;
      const turn = view.turns.at(-1);
      return {
        ...ref,
        owner,
        open,
        paused,
        pendingInput: view.hasPendingInput,
        damaged: deps.store.isDamaged(ref),
        latestCustomerAt: view.latestCustomerAt,
        lastNudgeAt: latestNoteAt(view, "nudge"),
        lastNudgeFailedAt: latestNoteAt(view, "nudge-failed"),
        expiredAt: expiredAt(view),
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
