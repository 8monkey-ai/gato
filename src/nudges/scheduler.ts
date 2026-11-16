import { setTimeout as sleep } from "node:timers/promises";

import type { Connection } from "../channels/channel.ts";
import type { Config } from "../config.ts";
import { agentActivity, latestCustomerAt } from "../conversation/history.ts";
import type { ConversationService } from "../conversation/service.ts";
import { log } from "../log.ts";
import type { Chat, Conversation, ConversationStore } from "../record/store.ts";
import { dueMilestone, windowStart, withinHours } from "./policy.ts";

type Deps = {
  config: Config;
  store: ConversationStore;
  connections: ReadonlyMap<string, Connection>;
  service: ConversationService;
};

export function startNudges(deps: Deps) {
  const stop = new AbortController();
  let ready = false;
  const stopped = new Promise((resolve) =>
    stop.signal.addEventListener("abort", resolve),
  );
  const loop = async () => {
    const reconciled = [...deps.connections.values()].map((c) => c.reconciled);
    await Promise.race([Promise.all(reconciled), stopped]);
    if (stop.signal.aborted) return;
    ready = true;
    log.info("nudges.ready");
    while (!stop.signal.aborted) {
      await sleep(deps.config.nudges.intervalMs, undefined, {
        signal: stop.signal,
      });
      await check(deps);
    }
  };
  const running = deps.config.nudges.enabled
    ? loop().catch((error: unknown) => {
        if (!stop.signal.aborted) log.error("nudges.stopped", { error });
      })
    : Promise.resolve();
  return {
    isReady: () => ready,
    async stop() {
      stop.abort();
      await running;
    },
  };
}

function isDue({ entries, damaged }: Chat, config: Config) {
  const customerAt = latestCustomerAt(entries);
  if (customerAt === undefined || damaged) return false;
  return (
    dueMilestone(
      customerAt,
      agentActivity(entries),
      config.nudges.milestonesMs,
      Date.now(),
    ) !== undefined
  );
}

async function check(deps: Deps) {
  const { hours, milestonesMs } = deps.config.nudges;
  if (hours && !withinHours(new Date(), hours, deps.config.timezone)) return;
  const since = windowStart(milestonesMs, Date.now());
  for (const connection of deps.connections.values()) {
    for (const conversation of await deps.store.changedSince(
      connection.id,
      since,
    ))
      await attempt(deps, connection, conversation);
  }
}

async function attempt(
  deps: Deps,
  connection: Connection,
  conversation: Conversation,
) {
  const where = { connection: connection.id, contact: conversation.contact };
  try {
    if (
      !isDue(await conversation.read(), deps.config) ||
      deps.service.isBusy(conversation) ||
      !(await connection.isAgentOwned(conversation.contact))
    )
      return;
    const noted = await conversation.lock(async (edit) => {
      if (!isDue(edit, deps.config) || deps.service.isBusy(conversation))
        return false;
      edit.add({
        kind: "note",
        author: "agent",
        at: new Date().toISOString(),
        text: "Nudge",
      });
      await edit.save();
      return true;
    });
    if (!noted) return;
    log.info("nudge.started", where);
    await connection
      .note?.(conversation.contact, "Nudge")
      .catch((error: unknown) => {
        log.warn("nudge.note_failed", { ...where, error });
      });
    deps.service.requestTurn(conversation, connection, "nudge");
  } catch (error) {
    log.error("nudge.failed", { ...where, error });
  }
}
