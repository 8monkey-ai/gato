import type { ChannelConnection } from "../channels/channel.ts";
import { chatState } from "../conversation/ownership.ts";
import type { Logger } from "../log.ts";
import type { ChatView } from "../record/projection.ts";
import type { ChatRef, Owner } from "../record/types.ts";
import { chatKey } from "../storage/chat-files.ts";
import type { ChatStore, NewEntry } from "../storage/chat-store.ts";

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

const ownerOf = (view: ChatView) =>
  chatState(view, { native: true, paused: false, closed: false }).owner;

export function createReconciler(deps: {
  store: Pick<ChatStore, "withChat">;
  connection: (connectionId: string) => ChannelConnection;
  log: Logger;
  now: () => Date;
  onOwnershipChange: (ref: ChatRef, previous: Owner, owner: Owner) => unknown;
}) {
  const reconciled = new Set<string>();
  const isReconciled = (ref: ChatRef) =>
    !deps.connection(ref.connectionId).assignment ||
    reconciled.has(chatKey(ref));
  const reconcile = async (ref: ChatRef) => {
    const assignment = deps.connection(ref.connectionId).assignment;
    if (!assignment || reconciled.has(chatKey(ref))) return true;
    try {
      const fetched = await assignment.fetchState(ref.chatId);
      const eventAt = deps.now().toISOString();
      const [previous, owner] = await deps.store.withChat(
        ref,
        async (session) => {
          const before = session.view();
          const after = await session.append(
            differences(before, fetched, eventAt),
          );
          return [ownerOf(before), ownerOf(after)] as const;
        },
      );
      reconciled.add(chatKey(ref));
      if (previous !== owner) deps.onOwnershipChange(ref, previous, owner);
      return true;
    } catch (error) {
      deps.log.warn("nudge.reconcile_failed", { ...ref, error });
      return false;
    }
  };
  return { isReconciled, reconcile };
}
