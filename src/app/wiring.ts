import type { ModelProvider } from "../agent/models.ts";
import { createTurnRunner } from "../agent/turn.ts";
import {
  createAttachmentRetrieval,
  type RetrieveAttachments,
} from "../attachments/retrieve.ts";
import type { ChannelConnection } from "../channels/channel.ts";
import type { Settings } from "../config/settings.ts";
import { type Controls, createControls } from "../conversation/controls.ts";
import { createIngest } from "../conversation/ingest.ts";
import { mergeChats } from "../conversation/merge.ts";
import { createReconciler } from "../conversation/reconcile.ts";
import { createScheduler } from "../conversation/scheduler.ts";
import { createDelivery } from "../delivery/deliver.ts";
import type { Logger } from "../log.ts";
import { createNudgeChecker } from "../nudges/checker.ts";
import { failedNudges, retryFailedNudges } from "../nudges/retry.ts";
import type { ChatRef } from "../record/types.ts";
import { inspectChats } from "../server/inspect.ts";
import { opsRoutes } from "../server/ops.ts";
import type { ChatStore } from "../storage/chat-store.ts";
import type { AgentTool } from "../tools/tool.ts";

type Core = {
  settings: Settings;
  store: ChatStore;
  connections: ReadonlyMap<string, ChannelConnection>;
  provider: ModelProvider;
  summaryPrompt: string;
  mcpTools: AgentTool[];
  log: Logger;
  now: () => Date;
};
type Scheduler = ReturnType<typeof createScheduler>;

function operatorRoutes(
  { settings, store, log }: Core,
  controls: Controls,
  scheduler: Scheduler,
) {
  if (settings.opsToken === undefined) return {};
  const deps = { store, controls, policy: settings.ownershipPolicy };
  return opsRoutes({
    token: settings.opsToken,
    failedNudges: (since) => failedNudges(deps, since),
    retryFailedNudges: (since) =>
      retryFailedNudges({ ...deps, scheduler, log }, since),
    merge: (connectionId, fromChatId, intoChatId) =>
      mergeChats(
        { store, abortTurn: scheduler.abort },
        { connectionId, chatId: fromChatId },
        { connectionId, chatId: intoChatId },
      ),
    inspect: () => inspectChats({ store, controls }),
  });
}

function retrievalAfterIngest(
  { store, log }: Core,
  connection: (id: string) => ChannelConnection,
  retrieve: RetrieveAttachments,
) {
  return (ref: ChatRef) =>
    retrieve({
      store,
      ref,
      connection: connection(ref.connectionId),
      log: log.child(ref),
      signal: AbortSignal.timeout(60_000),
    });
}

const connectionLookup =
  ({ connections }: Core) =>
  (id: string) => {
    const found = connections.get(id);
    if (!found) throw new Error(`Unknown connection: ${id}`);
    return found;
  };

function agentServices(
  core: Core,
  connection: (id: string) => ChannelConnection,
) {
  const { settings, store, log, now } = core;
  const controls = createControls({
    store,
    connection,
    labels: settings.labels,
    log,
  });
  const retrieveAttachments = createAttachmentRetrieval();
  const runTurn = createTurnRunner({
    ...core,
    retrieveAttachments,
    controls,
    connection,
    skillsDir: settings.skillsDir,
    delivery: createDelivery({ store, settings: settings.delivery, log, now }),
  });
  return { controls, retrieveAttachments, runTurn };
}

export function wireServices(core: Core) {
  const { settings, store, log, now } = core;
  const connection = connectionLookup(core);
  const { controls, retrieveAttachments, runTurn } = agentServices(
    core,
    connection,
  );
  const reconciler = createReconciler({
    store,
    controls,
    connection,
    log,
    now,
  });
  const scheduler = createScheduler({
    store,
    controls,
    policy: settings.ownershipPolicy,
    reconcile: reconciler.reconcile,
    runTurn,
    log,
  });
  const ingest = createIngest({
    store,
    controls,
    log,
    now,
    onCustomerMessage: scheduler.customerMessage,
    onStateChange: scheduler.stateChanged,
    onNewAttachments: retrievalAfterIngest(
      core,
      connection,
      retrieveAttachments,
    ),
  });
  const checker = createNudgeChecker({
    store,
    controls,
    scheduler,
    reconciler,
    connection,
    settings,
    log,
    now,
  });
  const routes = operatorRoutes(core, controls, scheduler);
  return { scheduler, ingest, checker, routes };
}
