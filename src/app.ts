import type { Inbox, RouteHandler } from "./channels/channel.ts";
import type { EnvSource } from "./config/env.ts";
import { readEnv } from "./config/env.ts";
import type { Settings } from "./config/settings.ts";
import { configuredModels, parseSettings } from "./config/settings.ts";
import { readConnections } from "./connections.ts";
import type { Conversations } from "./conversation/conversations.ts";
import {
  createConversations,
  DamagedHistory,
} from "./conversation/conversations.ts";
import { createInbox } from "./conversation/inbox.ts";
import { recover } from "./conversation/recovery.ts";
import type { Conversation } from "./conversation/store.ts";
import { checkWritable, loadAll } from "./conversation/store.ts";
import { errorText, log } from "./log.ts";
import { verifyModels } from "./models.ts";
import { createNudges } from "./nudges/scheduler.ts";
import type { Channels, Runtime } from "./runtime.ts";
import { createRuntime } from "./runtime.ts";
import { createSkills } from "./skills/catalogue.ts";
import { connectServers, readMcpServers } from "./tools/servers.ts";

function serve(
  port: number,
  channels: Channels,
  health: () => Promise<{ ready: boolean }>,
) {
  const routes: Record<string, RouteHandler> = {};
  for (const channel of channels.values())
    Object.assign(routes, channel.routes);
  return Bun.serve({
    port,
    routes: {
      ...routes,
      "/health": async () => {
        const status = await health();
        return Response.json(status, { status: status.ready ? 200 : 503 });
      },
    },
    fetch: () => new Response("Not found", { status: 404 }),
  });
}

function inboxFor(
  connection: string,
  conversations: Conversations,
  runtime: Runtime,
  fail: (error: unknown) => void,
) {
  return createInbox({
    fail,
    conversation(chat) {
      try {
        return conversations.get(connection, chat);
      } catch (error) {
        if (!(error instanceof DamagedHistory)) throw error;
        log("error", "history.event_not_recorded", {
          connection,
          chat,
          error: errorText(error),
        });
        return undefined;
      }
    },
    retrieve: (conversation) => void runtime.retrieve(conversation),
    customerWrote(conversation) {
      runtime.turns.interrupt(conversation);
      runtime.turns.request(conversation, "reply");
    },
    assignedToAgent: (conversation) =>
      runtime.turns.request(conversation, "review"),
  });
}

async function openStorage(dataDir: string) {
  await checkWritable(dataDir);
  const { loaded, damaged } = await loadAll(dataDir);
  for (const item of damaged) log("error", "history.damaged", { ...item });
  return {
    conversations: createConversations(dataDir, loaded, damaged),
    damaged,
  };
}

async function resume(
  conversations: Conversations,
  channels: Channels,
  runtime: Runtime,
) {
  await recover(
    conversations.all(),
    (conversation) => channels.get(conversation.connection),
    (conversation) => {
      if (conversation.state.pendingReply)
        runtime.turns.request(conversation, "reply");
      void runtime.retrieve(conversation);
    },
  );
}

async function loadInstructions(settings: Settings) {
  if (!(await Bun.file(settings.summaryPromptFile).exists())) {
    throw new Error(
      `The summary prompt file ${settings.summaryPromptFile} does not exist.`,
    );
  }
  const skills = createSkills(settings.skillsDir, settings.country);
  await skills.current();
  return skills;
}

function nudgesFor(
  settings: Settings,
  channels: Channels,
  conversations: Conversations,
  runtime: Runtime,
  inboxes: Map<string, Inbox>,
) {
  return createNudges({
    settings: settings.nudges,
    timezone: settings.timezone,
    conversations: () => conversations.all(),
    channelOf: (conversation) => channels.get(conversation.connection),
    eligible: runtime.eligible,
    busy: (conversation) => runtime.turns.isBusy(conversation),
    async refresh(conversation: Conversation) {
      const channel = runtime.channelOf(conversation);
      if (channel.reconcile)
        await inboxes
          .get(conversation.connection)!
          .handle(await channel.reconcile(conversation.chat));
    },
    requestNudge: (conversation) =>
      runtime.turns.request(conversation, "nudge"),
  });
}

async function startChannels(
  channels: Channels,
  conversations: Conversations,
  runtime: Runtime,
  inboxes: Map<string, Inbox>,
  fail: (error: unknown) => void,
) {
  for (const [connection, channel] of channels) {
    const inbox = inboxFor(connection, conversations, runtime, fail);
    inboxes.set(connection, inbox);
    await channel.start(inbox);
  }
}

export async function startApp(
  source: EnvSource,
  fail: (error: unknown) => void,
) {
  const env = readEnv(source);
  const settings = parseSettings(env);
  const channels = readConnections(env);
  const { conversations, damaged } = await openStorage(settings.dataDir);
  const skills = await loadInstructions(settings);
  await verifyModels(settings.gateway, configuredModels(settings));
  const sharedTools = await connectServers(
    readMcpServers(env, [...channels.keys()]),
  );
  const runtime = createRuntime(settings, channels, skills, sharedTools);
  await resume(conversations, channels, runtime);
  let ready = false;
  const inboxes = new Map<string, Inbox>();
  const nudges = nudgesFor(settings, channels, conversations, runtime, inboxes);
  const health = async () => ({
    ready,
    connections: [...channels.keys()],
    damagedHistories: damaged,
    skillProblems: await skills
      .problems()
      .catch((error: unknown) => [errorText(error)]),
    nudges: nudges.status(),
  });
  const server = serve(settings.port, channels, health);
  await startChannels(channels, conversations, runtime, inboxes, fail);
  nudges.start();
  ready = true;
  log("info", "app.ready", {
    port: server.port,
    connections: [...channels.keys()],
  });
  return {
    async stop() {
      ready = false;
      await nudges.stop();
      await server.stop();
      await Promise.all(
        [...channels.values()].map((channel) => channel.stop()),
      );
      await runtime.turns.stop(settings.shutdownGraceMs);
    },
  };
}
