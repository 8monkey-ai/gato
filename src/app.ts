import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import { createPreparer } from "./agent/prepare.ts";
import { createTurnRunner } from "./agent/runner.ts";
import type { Channel, RouteHandler } from "./channels/channel.ts";
import type { EnvSource } from "./config/env.ts";
import { readEnv } from "./config/env.ts";
import type { Settings } from "./config/settings.ts";
import { parseSettings } from "./config/settings.ts";
import { readConnections } from "./connections.ts";
import type { Conversations } from "./conversation/conversations.ts";
import {
  createConversations,
  DamagedHistory,
} from "./conversation/conversations.ts";
import { createInbox } from "./conversation/inbox.ts";
import { mayAnswer } from "./conversation/ownership.ts";
import { recover } from "./conversation/recovery.ts";
import { createRetriever } from "./conversation/retrieval.ts";
import type { Conversation } from "./conversation/store.ts";
import { checkWritable, loadAll } from "./conversation/store.ts";
import { createTurns } from "./conversation/turns.ts";
import { errorText, log } from "./log.ts";

type Channels = Map<string, Channel>;

function createRuntime(settings: Settings, channels: Channels) {
  const channelOf = (conversation: Conversation) =>
    channels.get(conversation.connection) as Channel;
  const retrieve = createRetriever(channelOf);
  const eligible = (conversation: Conversation) =>
    mayAnswer(settings.ownershipPolicy, conversation.state);
  const gateway = createOpenRouter(settings.gateway);
  const runner = createTurnRunner({
    settings,
    channelOf,
    model: gateway(settings.model),
    prepare: createPreparer({
      settings,
      retrieve,
      tools: () => Promise.resolve({}),
    }),
    afterTurn: () => Promise.resolve(),
    nudgeInstruction: "Nudge",
  });
  return { retrieve, turns: createTurns(runner, eligible) };
}

type Runtime = ReturnType<typeof createRuntime>;

function serve(
  port: number,
  channels: Channels,
  health: () => { ready: boolean },
) {
  const routes: Record<string, RouteHandler> = {};
  for (const channel of channels.values())
    Object.assign(routes, channel.routes);
  return Bun.serve({
    port,
    routes: {
      ...routes,
      "/health": () => {
        const status = health();
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

export async function startApp(
  source: EnvSource,
  fail: (error: unknown) => void,
) {
  const env = readEnv(source);
  const settings = parseSettings(env);
  const channels = readConnections(env);
  await checkWritable(settings.dataDir);
  const { loaded, damaged } = await loadAll(settings.dataDir);
  for (const item of damaged) log("error", "history.damaged", { ...item });
  const conversations = createConversations(settings.dataDir, loaded, damaged);
  const runtime = createRuntime(settings, channels);
  await recover(
    conversations.all(),
    (c) => channels.get(c.connection),
    (conversation) => {
      if (conversation.state.pendingReply)
        runtime.turns.request(conversation, "reply");
      void runtime.retrieve(conversation);
    },
  );
  let ready = false;
  const health = () => ({
    ready,
    connections: [...channels.keys()],
    damagedHistories: damaged,
  });
  const server = serve(settings.port, channels, health);
  for (const [connection, channel] of channels) {
    await channel.start(inboxFor(connection, conversations, runtime, fail));
  }
  ready = true;
  log("info", "app.ready", {
    port: server.port,
    connections: [...channels.keys()],
  });
  return {
    async stop() {
      ready = false;
      await server.stop();
      await Promise.all(
        [...channels.values()].map((channel) => channel.stop()),
      );
      await runtime.turns.stop(settings.shutdownGraceMs);
    },
  };
}
