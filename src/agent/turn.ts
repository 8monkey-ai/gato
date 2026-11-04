import { randomUUID } from "node:crypto";

import type { ChannelConnection } from "../channels/channel.ts";
import type { Controls } from "../conversation/controls.ts";
import { mayAnswer } from "../conversation/ownership.ts";
import type { createDelivery } from "../delivery/deliver.ts";
import type { DeliveryResult } from "../delivery/sender.ts";
import type { Logger } from "../log.ts";
import type { ChatRef, Entry, TurnEnd, TurnTrigger } from "../record/types.ts";
import { loadRevision, type Revision } from "../skills/loader.ts";
import { readSkillTool } from "../skills/read-tool.ts";
import type { AgentTool } from "../tools/tool.ts";
import { assertUniqueToolNames } from "../tools/toolset.ts";
import { toAiTools, type ToolRecorder } from "./ai-tools.ts";
import { createBudget, type TurnBudget } from "./budget.ts";
import { handoffTool } from "./handoff-tool.ts";
import { buildContext, type ContextDeps } from "./turn-context.ts";
import { generate, type Generation } from "./turn-generate.ts";
import { abortEnd, type End, errorEnd, resultEnd } from "./turn-outcome.ts";
import {
  append,
  failTurn,
  finish,
  isNudge,
  startTurn,
  type Turn,
  type Work,
} from "./turn-record.ts";

export type TurnDeps = ContextDeps & {
  controls: Controls;
  connection: (connectionId: string) => ChannelConnection;
  skillsDir: string;
  mcpTools: AgentTool[];
  delivery: ReturnType<typeof createDelivery>;
  log: Logger;
};

type TurnRun = Turn & { deps: TurnDeps };
type Trigger = Extract<Entry, { type: "trigger" }>;
type Composed = (Generation & { handedOff: boolean }) | { error: unknown };

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

async function toolsFor(
  turn: TurnRun,
  revision: Revision,
  onHandoff: () => void,
) {
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
  turn: TurnRun,
  revision: Revision,
  budget: TurnBudget,
  trigger: Trigger | undefined,
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

function endOf(
  turn: Turn,
  budget: TurnBudget,
  composed: Composed,
  delivery: DeliveryResult,
): End {
  const aborted = abortEnd(turn.signal, budget.signal);
  if (aborted) return aborted;
  if ("error" in composed) return errorEnd(composed.error);
  if ("error" in delivery) return errorEnd(delivery.error);
  return resultEnd(composed, delivery);
}

async function reply(
  turn: TurnRun,
  revision: Revision,
  budget: TurnBudget,
  trigger?: Trigger,
): Promise<Work> {
  const { deps, ref, turnId, connection } = turn;
  const stopDelivery = new AbortController();
  const delivery = deps.delivery.start({
    ref,
    connection,
    turnId,
    signal: AbortSignal.any([budget.signal, stopDelivery.signal]),
  });
  const push = (delta: string) => delivery.push(delta);
  const composed: Composed = await compose(
    turn,
    revision,
    budget,
    trigger,
    push,
  ).catch((error: unknown) => {
    stopDelivery.abort("failed");
    return { error };
  });
  const result = await delivery.end();
  const end = endOf(turn, budget, composed, result);
  if (end.outcome === "skipped")
    await deps.controls.note(ref, {
      by: "agent",
      kind: "skip",
      text: "No reply generated",
      turnId,
    });
  return { end, sentParts: result.sentParts };
}

async function run(turn: TurnRun, revision: Revision): Promise<TurnEnd> {
  const { deps } = turn;
  for (const problem of revision.problems)
    turn.log.warn("skills.problem", { problem });
  const state = await deps.controls.state(turn.ref);
  if (!mayAnswer(state, deps.settings.ownershipPolicy)) {
    await startTurn(turn, revision);
    const end: End = { outcome: "skipped", reason: "not eligible" };
    return finish(turn, { end, sentParts: 0 });
  }
  const prompt = {
    type: "trigger",
    turnId: turn.turnId,
    text: deps.settings.nudges.prompt,
  } as const;
  const started = await startTurn(
    turn,
    revision,
    isNudge(turn.trigger) ? [prompt] : [],
  );
  const trigger = started.triggers.find((t) => t.turnId === turn.turnId);
  const budget = createBudget(deps.settings.turn, turn.signal);
  try {
    return await finish(turn, await reply(turn, revision, budget, trigger));
  } finally {
    budget.dispose();
  }
}

async function runRecorded(turn: TurnRun): Promise<TurnEnd> {
  let revision: Revision | undefined;
  try {
    revision = await loadRevision(
      turn.deps.skillsDir,
      turn.deps.settings.country,
    );
    return await run(turn, revision);
  } catch (error) {
    return failTurn(turn, revision, error);
  }
}

// Never rejects: a turn that cannot even record its end is logged and counts as failed.
export function createTurnRunner(deps: TurnDeps) {
  return async (
    ref: ChatRef,
    trigger: TurnTrigger,
    signal: AbortSignal,
  ): Promise<TurnEnd> => {
    const turnId = randomUUID();
    const log = deps.log.child({ turnId, ...ref });
    try {
      const connection = deps.connection(ref.connectionId);
      const turn = { deps, ref, trigger, signal, turnId, connection, log };
      return await runRecorded({ ...turn, started: false });
    } catch (error) {
      log.error("turn.record_failed", { error });
      return "failed";
    }
  };
}
