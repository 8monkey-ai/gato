import { randomUUID } from "node:crypto";

import type { ChannelConnection } from "../channels/channel.ts";
import type { Controls } from "../conversation/controls.ts";
import { agentMayAnswer } from "../conversation/ownership.ts";
import type { createDelivery } from "../delivery/deliver.ts";
import type { Logger } from "../log.ts";
import type {
  ChatRef,
  Entry,
  EntryBody,
  TurnEnd,
  TurnTrigger,
} from "../record/types.ts";
import { loadRevision, type Revision } from "../skills/loader.ts";
import { readSkillTool } from "../skills/read-tool.ts";
import type { AgentTool } from "../tools/tool.ts";
import { assertUniqueToolNames } from "../tools/toolset.ts";
import { toAiTools, type ToolRecorder } from "./ai-tools.ts";
import { createBudget, type TurnBudget } from "./budget.ts";
import { handoffTool } from "./handoff-tool.ts";
import { buildContext, type ContextDeps } from "./turn-context.ts";
import { generate } from "./turn-generate.ts";
import { abortEnd, type End, errorEnd, resultEnd } from "./turn-outcome.ts";

export type TurnDeps = ContextDeps & {
  controls: Controls;
  connection: (connectionId: string) => ChannelConnection;
  skillsDir: string;
  mcpTools: AgentTool[];
  delivery: ReturnType<typeof createDelivery>;
  log: Logger;
};

type Turn = {
  deps: TurnDeps;
  ref: ChatRef;
  trigger: TurnTrigger;
  signal: AbortSignal;
  turnId: string;
  connection: ChannelConnection;
  log: Logger;
};

type Work = { end: End; sentParts: number };

const isNudge = (trigger: TurnTrigger) =>
  trigger === "nudge" || trigger === "nudge-retry";

const append = (turn: Turn, bodies: EntryBody[]) =>
  turn.deps.store.append(turn.ref, bodies);

const turnStart = (turn: Turn, inputThroughSeq: number, revision: string) =>
  ({
    type: "turn-start",
    turnId: turn.turnId,
    trigger: turn.trigger,
    inputThroughSeq,
    instructionsRevision: revision,
  }) satisfies EntryBody;

function recorder(turn: Turn): ToolRecorder {
  const { turnId } = turn;
  return {
    async call(callId, name, input) {
      turn.log.info("tool.call", { callId, name });
      await append(turn, [{ type: "tool-call", turnId, callId, name, input }]);
    },
    async result(callId, name, { output, isError }) {
      turn.log.info("tool.result", { callId, name, isError });
      await append(turn, [
        { type: "tool-result", turnId, callId, name, output, isError },
      ]);
    },
  };
}

async function toolsFor(turn: Turn, revision: Revision, onHandoff: () => void) {
  const { deps, ref, turnId } = turn;
  const tools = [
    readSkillTool(revision),
    handoffTool({ ref, turnId, controls: deps.controls, onHandoff }),
    ...deps.mcpTools,
    ...((await turn.connection.contactTools?.(ref.chatId)) ?? []),
  ];
  assertUniqueToolNames(tools);
  return toAiTools(tools, recorder(turn));
}

async function compose(
  turn: Turn,
  revision: Revision,
  budget: TurnBudget,
  trigger: Extract<Entry, { type: "trigger" }> | undefined,
  push: (delta: string) => void,
) {
  const { deps, ref, connection, log } = turn;
  let handedOff = false;
  const context = await buildContext(deps, {
    ref,
    connection,
    revision,
    budget,
    trigger,
    log,
  });
  const tools = await toolsFor(turn, revision, () => (handedOff = true));
  const model = deps.provider(deps.settings.model);
  const generation = await generate({ ...context, model, tools, budget, push });
  return { ...generation, handedOff };
}

async function reply(
  turn: Turn,
  revision: Revision,
  budget: TurnBudget,
  trigger?: Extract<Entry, { type: "trigger" }>,
): Promise<Work> {
  const { deps, ref, turnId, connection } = turn;
  const stopDelivery = new AbortController();
  const delivery = deps.delivery.start({
    ref,
    connection,
    turnId,
    signal: AbortSignal.any([budget.signal, stopDelivery.signal]),
  });
  try {
    const push = (delta: string) => delivery.push(delta);
    const generation = await compose(turn, revision, budget, trigger, push);
    const result = await delivery.end();
    const end =
      abortEnd(turn.signal, budget.signal) ?? resultEnd(generation, result);
    if (end.outcome === "skipped")
      await deps.controls.note(ref, {
        by: "agent",
        kind: "skip",
        text: "No reply generated",
        turnId,
      });
    return { end, sentParts: result.sentParts };
  } catch (error) {
    stopDelivery.abort("failed");
    const { sentParts } = await delivery.end();
    return {
      end: abortEnd(turn.signal, budget.signal) ?? errorEnd(error),
      sentParts,
    };
  }
}

async function errorHandoff(turn: Turn, end: End) {
  const { deps, ref, turnId } = turn;
  try {
    if ((await deps.controls.state(ref)).owner !== "agent") return;
    const reason = `The agent could not answer (${end.outcome}): ${end.reason ?? "no reason recorded"}`;
    await deps.controls.handoff(ref, { path: "error", reason, turnId });
  } catch (error) {
    turn.log.error("turn.error_handoff_failed", { error });
  }
}

async function finish(turn: Turn, { end, sentParts }: Work): Promise<TurnEnd> {
  const { outcome, reason } = end;
  await append(turn, [
    {
      type: "turn-end",
      turnId: turn.turnId,
      outcome,
      ...(reason ? { reason } : {}),
    },
  ]);
  turn.log.info("turn.end", { outcome, reason, sentParts });
  const failed = outcome === "failed" || outcome === "timed-out";
  if (failed && sentParts === 0 && !isNudge(turn.trigger))
    await errorHandoff(turn, end);
  return outcome;
}

async function unavailable(turn: Turn, error: unknown) {
  const view = await turn.deps.store.load(turn.ref);
  await append(turn, [turnStart(turn, view.lastSeq, "unavailable")]);
  return finish(turn, { end: errorEnd(error), sentParts: 0 });
}

async function run(turn: Turn, revision: Revision): Promise<TurnEnd> {
  const { deps } = turn;
  for (const problem of revision.problems)
    turn.log.warn("skills.problem", { problem });
  const { owner, open, view } = await deps.controls.state(turn.ref);
  const start = turnStart(turn, view.lastSeq, revision.id);
  if (!open || !agentMayAnswer(owner, deps.settings.ownershipPolicy)) {
    await append(turn, [start]);
    const end: End = { outcome: "skipped", reason: "not eligible" };
    return finish(turn, { end, sentParts: 0 });
  }
  const prompt = {
    type: "trigger",
    turnId: turn.turnId,
    text: deps.settings.nudges.prompt,
  } as const;
  const started = await append(
    turn,
    isNudge(turn.trigger) ? [start, prompt] : [start],
  );
  const trigger = started.triggers.find((t) => t.turnId === turn.turnId);
  const budget = createBudget(deps.settings.turn, turn.signal);
  try {
    return await finish(turn, await reply(turn, revision, budget, trigger));
  } finally {
    budget.dispose();
  }
}

export function createTurnRunner(deps: TurnDeps) {
  return async (
    ref: ChatRef,
    trigger: TurnTrigger,
    signal: AbortSignal,
  ): Promise<TurnEnd> => {
    const turnId = randomUUID();
    const log = deps.log.child({ turnId, ...ref });
    const connection = deps.connection(ref.connectionId);
    const turn = { deps, ref, trigger, signal, turnId, connection, log };
    let revision: Revision;
    try {
      revision = await loadRevision(deps.skillsDir, deps.settings.country);
    } catch (error) {
      return unavailable(turn, error);
    }
    return run(turn, revision);
  };
}
