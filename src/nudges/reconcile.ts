import type { ChannelConnection } from "../channels/channel.ts";
import type { Logger } from "../log.ts";
import type { ChatView } from "../record/projection.ts";
import type { ChatRef, Owner } from "../record/types.ts";
import type { ChatStore, NewEntry } from "../storage/chat-store.ts";
import { chatKey } from "./chats.ts";

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

export function createReconciler(deps: {
  store: Pick<ChatStore, "withChat">;
  connection: (connectionId: string) => ChannelConnection;
  log: Logger;
  now: () => Date;
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
      await deps.store.withChat(ref, (session) =>
        session.append(differences(session.view(), fetched, eventAt)),
      );
      reconciled.add(chatKey(ref));
      return true;
    } catch (error) {
      deps.log.warn("nudge.reconcile_failed", { ...ref, error });
      return false;
    }
  };
  return { isReconciled, reconcile };
}
