import type { ChannelConnection } from "../channels/channel.ts";
import type { Settings } from "../config/settings.ts";
import type { Logger } from "../log.ts";
import type { ChatRef, EntryBody } from "../record/types.ts";
import type { ChatStore } from "../storage/chat-store.ts";
import { localState } from "./local-state.ts";
import { chatState } from "./ownership.ts";

type NoteBody = Omit<Extract<EntryBody, { type: "note" }>, "type">;
type HandoffBody = Omit<Extract<EntryBody, { type: "handoff" }>, "type">;
type Context = {
  store: ChatStore;
  connection: (connectionId: string) => ChannelConnection;
  labels: Settings["labels"];
  log: Logger;
};

export type Controls = ReturnType<typeof createControls>;

async function attempt(
  { log }: Context,
  event: string,
  ref: ChatRef,
  fn: () => unknown,
) {
  try {
    await fn();
  } catch (error) {
    log.error(event, { ...ref, error });
  }
}

async function state(ctx: Context, ref: ChatRef) {
  const view = await ctx.store.load(ref);
  const native = ctx.connection(ref.connectionId).assignment !== undefined;
  const local = localState(ctx.store);
  const [paused, closed, merged] = await Promise.all([
    !native && local.isPaused(ref),
    !native && local.isClosed(ref),
    ctx.store.fileExists(ref, "merged-into"),
  ]);
  const current = chatState(view, { native, paused, closed });
  return { ...current, open: current.open && !merged, paused, view };
}

async function note(ctx: Context, ref: ChatRef, body: NoteBody) {
  await ctx.store.append(ref, [{ type: "note", ...body }]);
  const notes = ctx.connection(ref.connectionId).notes;
  if (notes)
    await attempt(ctx, "note.send_failed", ref, () =>
      notes.add(ref.chatId, body.text),
    );
}

async function addLabels(ctx: Context, ref: ChatRef, labels: string[]) {
  await ctx.store.append(ref, [{ type: "labels", labels }]);
  const port = ctx.connection(ref.connectionId).labels;
  await attempt(ctx, "labels.add_failed", ref, () =>
    port
      ? port.add(ref.chatId, labels)
      : localState(ctx.store).appendLocalLabels(ref, labels),
  );
}

function readLabels(ctx: Context, ref: ChatRef): Promise<string[]> {
  const port = ctx.connection(ref.connectionId).labels;
  return port
    ? port.read(ref.chatId)
    : localState(ctx.store).readLocalLabels(ref);
}

function handoffLabels({ labels }: Context, path: HandoffBody["path"]) {
  const reasonLabel = {
    tool: labels.outOfScope,
    error: labels.error,
    expiry: labels.expired,
  };
  return [labels.handoff, reasonLabel[path]];
}

async function handoff(ctx: Context, ref: ChatRef, body: HandoffBody) {
  const step = (fn: () => unknown) =>
    attempt(ctx, `handoff.${body.path}_failed`, ref, fn);
  const channel = ctx.connection(ref.connectionId);
  await step(() => ctx.store.append(ref, [{ type: "handoff", ...body }]));
  await step(() =>
    note(ctx, ref, {
      by: body.path === "tool" ? "agent" : "system",
      kind: "handoff",
      text: body.reason,
      turnId: body.turnId,
    }),
  );
  await step(() => addLabels(ctx, ref, handoffLabels(ctx, body.path)));
  if (!channel.assignment)
    await step(() => localState(ctx.store).pause(ref, body.reason));
  const text = `Operator attention needed (${body.path} handoff): ${body.reason}`;
  if (channel.notifyOperators)
    await step(() => channel.notifyOperators?.(ref.chatId, text));
  ctx.log.warn("handoff.operator_attention_needed", {
    ...ref,
    path: body.path,
    reason: body.reason,
  });
}

export function createControls(ctx: Context) {
  return {
    state: (ref: ChatRef) => state(ctx, ref),
    note: (ref: ChatRef, body: NoteBody) => note(ctx, ref, body),
    addLabels: (ref: ChatRef, labels: string[]) => addLabels(ctx, ref, labels),
    readLabels: (ref: ChatRef) => readLabels(ctx, ref),
    handoff: (ref: ChatRef, body: HandoffBody) =>
      attempt(ctx, `handoff.${body.path}_failed`, ref, () =>
        handoff(ctx, ref, body),
      ),
  };
}
