import { checkModels, createGateway } from "./agent/models.ts";
import { loadPrompts } from "./agent/prompts.ts";
import { createTurnRunner } from "./agent/turn.ts";
import type { ChannelFactory } from "./channels/channel.ts";
import { respondio } from "./channels/respondio/respondio.ts";
import { telegram } from "./channels/telegram/telegram.ts";
import { readConfig } from "./config.ts";
import { createConversationService } from "./conversation/service.ts";
import type { Env } from "./env.ts";
import { startHttp } from "./http.ts";
import { log, protectSecret } from "./log.ts";
import { startNudges } from "./nudges/scheduler.ts";
import { ConversationStore } from "./record/store.ts";
import { loadInstructions } from "./skills/skills.ts";
import { connectMcp, mcpServersFromEnv } from "./tools/mcp.ts";

// The closed set of channel adapters that this build links.
const channels: ChannelFactory[] = [telegram, respondio];

async function prepare(env: Env) {
  const config = readConfig(env);
  protectSecret(config.openrouter.apiKey);
  const prompts = loadPrompts();
  const instructions = await loadInstructions(config.skillsDir, config.country);
  if (instructions.problems.length)
    log.warn("skills.problems", { problems: instructions.problems });
  const mcpServers = mcpServersFromEnv(env);
  await Promise.all([
    checkModels(config),
    ...mcpServers.map(async (s) => (await connectMcp(s)).close()),
  ]);
  const store = await ConversationStore.open(config.conversationsDir);
  const connections = (
    await Promise.all(channels.map((create) => create(env)))
  ).flat();
  if (!connections.length) {
    throw new Error(
      "No channel is enabled. Set TELEGRAM_BOT_TOKENS or RESPONDIO_WORKSPACES.",
    );
  }
  const runTurn = createTurnRunner({
    config,
    prompts,
    gateway: createGateway(config.openrouter),
    mcpServers,
  });
  return { config, store, connections, runTurn };
}

async function serve({
  config,
  store,
  connections,
  runTurn,
}: Awaited<ReturnType<typeof prepare>>) {
  const damaged = store
    .list()
    .filter((c) => c.damaged)
    .map((c) => `${c.connection}/${c.contact}`);
  if (damaged.length) log.error("record.damaged", { conversations: damaged });
  const service = createConversationService(store, runTurn);
  const nudges = startNudges({
    config,
    store,
    connections: new Map(connections.map((c) => [c.id, c])),
    service,
  });
  let ready = true;
  const server = startHttp(config.port, connections, () => ({
    ready,
    connections: connections.map((c) => c.id),
    damagedConversations: damaged.length,
    nudges: config.nudges.enabled
      ? nudges.isReady()
        ? "ready"
        : "reconciling"
      : "disabled",
  }));
  await Promise.all(connections.map((c) => c.start(service.receive)));
  log.info("harness.ready", {
    port: server.port,
    connections: connections.map((c) => c.id),
  });
  return async () => {
    ready = false;
    await Promise.all([...connections.map((c) => c.stop()), nudges.stop()]);
    await service.stop(config.shutdownMs);
    await server.stop();
  };
}

function onSignal(stop: () => Promise<void>) {
  const shutdown = (signal: string) => {
    log.info("harness.stopping", { signal });
    void stop().then(() => {
      log.info("harness.stopped");
      process.exit(0);
    });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

prepare(process.env)
  .then(serve)
  .then(onSignal)
  .catch((error: unknown) => {
    log.error("harness.start_failed", { error });
    process.exit(1);
  });
