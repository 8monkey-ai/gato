import { createModelProvider, type ModelProvider } from "./agent/models.ts";
import { createFetch, routeTable } from "./app/http.ts";
import { type ModelsCheck, verifyModels } from "./app/models-check.ts";
import {
  connectionPrefix,
  readAppConfig,
  readSummaryPrompt,
} from "./app/settings.ts";
import {
  checkToolNames,
  warnUnpreparedCategories,
} from "./app/startup-checks.ts";
import { wireServices } from "./app/wiring.ts";
import type { ChannelConnection } from "./channels/channel.ts";
import { createLogger, type Logger } from "./log.ts";
import { loadRevision } from "./skills/loader.ts";
import { openChatStore } from "./storage/chat-store.ts";
import { acquireInstanceLock } from "./storage/instance-lock.ts";
import { connectMcpServers } from "./tools/mcp-servers.ts";

type AppDeps = {
  env: Record<string, string | undefined>;
  provider?: ModelProvider;
  now?: () => Date;
  log?: Logger;
};
type Config = ReturnType<typeof readAppConfig>;
type Cleanup = (() => Promise<unknown>)[];
type Services = ReturnType<typeof wireServices>;

export type Health = {
  ready: boolean;
  storage: "writable";
  damagedChats: number;
  connections: { id: string; started: boolean; healthy: boolean }[];
  mcpServers: string[];
  models: ModelsCheck;
  nudges: ReturnType<Services["checker"]["readiness"]>;
};

async function checkInstructions({ settings }: Config, log: Logger) {
  const revision = await loadRevision(
    settings.skillsDir,
    settings.country,
  ).catch((error: unknown) => {
    throw new Error(
      `Instructions in ${settings.skillsDir} are not usable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  });
  for (const problem of revision.problems)
    log.warn("skills.problem", { problem });
}

async function createConnections(
  config: Config,
  log: Logger,
  cleanup: Cleanup,
) {
  const connections = new Map<string, ChannelConnection>();
  for (const { id, channel } of config.connections) {
    const env = config.env.scope(connectionPrefix(id));
    const connection = await channel.create(
      id,
      env,
      log.child({ connectionId: id }),
    );
    cleanup.push(() => connection.stop());
    connections.set(id, connection);
  }
  // Adapters read their own settings while they are created.
  config.env.assertValid();
  return connections;
}

async function openStorage(
  { settings }: Config,
  log: Logger,
  now: () => Date,
  cleanup: Cleanup,
) {
  const release = await acquireInstanceLock(settings.dataDir);
  cleanup.push(release);
  const store = await openChatStore(settings.dataDir, {
    timeZone: settings.timeZone,
    log,
    now,
  });
  const damagedChats = store.damaged().length;
  if (damagedChats > 0)
    log.warn("storage.damaged_chats", { count: damagedChats });
  return { release, store };
}

async function modelAccess({ settings }: Config, deps: AppDeps, log: Logger) {
  if (deps.provider)
    return { provider: deps.provider, models: "not checked" as ModelsCheck };
  return {
    provider: createModelProvider(settings.openRouterApiKey),
    models: await verifyModels(settings, log),
  };
}

async function assemble(
  config: Config,
  deps: AppDeps,
  log: Logger,
  cleanup: Cleanup,
) {
  const { settings } = config;
  const now = deps.now ?? (() => new Date());
  const { release, store } = await openStorage(config, log, now, cleanup);
  await checkInstructions(config, log);
  warnUnpreparedCategories(settings.preparationModels, log);
  const summaryPrompt = await readSummaryPrompt(settings.summaryPromptFile);
  const { provider, models } = await modelAccess(config, deps, log);
  const mcp = await connectMcpServers(config.mcpServers, log);
  cleanup.push(() => mcp.close());
  const connections = await createConnections(config, log, cleanup);
  await checkToolNames(connections.values(), mcp.tools);
  const services = wireServices({
    settings,
    store,
    connections,
    provider,
    summaryPrompt,
    mcpTools: mcp.tools,
    log,
    now,
  });
  const adapterRoutes = [...connections.values()].map((c) => c.routes ?? {});
  const routes = routeTable(...adapterRoutes, services.routes);
  return {
    settings,
    connections,
    services,
    routes,
    store,
    models,
    mcp,
    release,
  };
}

type Assembled = Awaited<ReturnType<typeof assemble>>;

function lifecycle(app: Assembled, log: Logger) {
  const { connections, services, settings } = app;
  const started = new Set<string>();
  let ready = false;
  let stopping: Promise<void> | undefined;
  const stopAll = async () => {
    services.checker.stop();
    // The scheduler also ends running nudge turns, so the running check can finish after it.
    // Running turns still send replies and use contact tools, so connections stop after them.
    await services.scheduler.stop(settings.shutdownGraceMs);
    await services.checker.settled();
    for (const [id, connection] of connections)
      await connection
        .stop()
        .catch((error: unknown) =>
          log.error("connection.stop_failed", { connectionId: id, error }),
        );
    await app.mcp.close();
    await app.release();
  };
  return {
    started,
    ready: () => ready && stopping === undefined,
    stopping: () => stopping !== undefined,
    start: async () => {
      await services.scheduler.recover();
      for (const [id, connection] of connections) {
        await connection.start(services.ingest.sinkFor(id));
        started.add(id);
      }
      services.checker.start();
      ready = true;
      log.info("app.started", { connections: [...started] });
    },
    stop: () => (stopping ??= stopAll()),
  };
}

export async function createApp(deps: AppDeps) {
  const log = deps.log ?? createLogger();
  const config = readAppConfig(deps.env);
  const cleanup: Cleanup = [];
  let app: Assembled;
  try {
    app = await assemble(config, deps, log, cleanup);
  } catch (error) {
    for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
    throw error;
  }
  const life = lifecycle(app, log);
  const health = (): Health => {
    const connections = [...app.connections].map(([id, connection]) => ({
      id,
      started: life.started.has(id),
      healthy: connection.healthy?.() ?? true,
    }));
    return {
      ready: life.ready() && connections.every((c) => c.healthy),
      storage: "writable",
      damagedChats: app.store.damaged().length,
      connections,
      mcpServers: config.mcpServers.map((server) => server.id),
      models: app.models,
      nudges: app.services.checker.readiness(),
    };
  };
  const fetch = createFetch({
    routes: app.routes,
    health,
    accepting: () => !life.stopping(),
  });
  return {
    port: app.settings.port,
    fetch,
    health,
    start: life.start,
    stop: life.stop,
  };
}
