import type { ChannelConnection } from "../channels/channel.ts";
import type { Logger } from "../log.ts";
import type { ChatView } from "../record/projection.ts";
import type { ChatRef, Owner } from "../record/types.ts";
import { chatKey } from "../storage/chat-files.ts";
import type { ChatStore, NewEntry } from "../storage/chat-store.ts";
import type { Controls } from "./controls.ts";
import { type ChatState, sameState } from "./ownership.ts";

type Fetched = { owner: Owner; assigneeId?: string; open: boolean };

function differences(view: ChatView, fetched: Fetched, eventAt: string) {
  const entries: NewEntry[] = [];
  const known = view.ownership;
  if (
    (known?.owner ?? "none") !== fetched.owner ||
    known?.assigneeId !== fetched.assigneeId
  )
    entries.push({
      type: "ownership",
      owner: fetched.owner,
      assigneeId: fetched.assigneeId,
      eventAt,
    });
  if ((view.open?.open ?? true) !== fetched.open)
    entries.push({ type: "status", open: fetched.open, eventAt });
  return entries;
}

// Fetches the native state of a chat once per process and records what differs.
export function createReconciler(deps: {
  store: Pick<ChatStore, "withChat">;
  controls: Pick<Controls, "state">;
  connection: (connectionId: string) => ChannelConnection;
  log: Logger;
  now: () => Date;
}) {
  const reconciled = new Set<string>();
  const isReconciled = (ref: ChatRef) =>
    !deps.connection(ref.connectionId).assignment ||
    reconciled.has(chatKey(ref));
  const reconcile = async (
    ref: ChatRef,
    onChange?: (previous: ChatState, current: ChatState) => unknown,
  ) => {
    const assignment = deps.connection(ref.connectionId).assignment;
    if (!assignment || reconciled.has(chatKey(ref))) return true;
    try {
      // The fetched state is at least as new as the time before the request.
      const eventAt = deps.now().toISOString();
      const fetched = await assignment.fetchState(ref.chatId);
      const [previous, current] = await deps.store.withChat(
        ref,
        async (session) => {
          const before = await deps.controls.state(ref);
          await session.append(differences(session.view(), fetched, eventAt));
          return [before, await deps.controls.state(ref)] as const;
        },
      );
      reconciled.add(chatKey(ref));
      if (!sameState(previous, current)) onChange?.(previous, current);
      return true;
    } catch (error) {
      deps.log.warn("reconcile.failed", { ...ref, error });
      return false;
    }
  };
  return { isReconciled, reconcile };
}
