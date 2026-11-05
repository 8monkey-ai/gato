import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import { createAfterTurn } from "./agent/after-turn.ts";
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
import { handoff } from "./conversation/handoff.ts";
import { createInbox } from "./conversation/inbox.ts";
import { mayAnswer } from "./conversation/ownership.ts";
import { recover } from "./conversation/recovery.ts";
import { createRetriever } from "./conversation/retrieval.ts";
import type { Conversation } from "./conversation/store.ts";
import { checkWritable, loadAll } from "./conversation/store.ts";
import { createTurns } from "./conversation/turns.ts";
import { errorText, log } from "./log.ts";
import type { Skills } from "./skills/catalogue.ts";
import { createSkills } from "./skills/catalogue.ts";

type Channels = Map<string, Channel>;

function createRuntime(settings: Settings, channels: Channels, skills: Skills) {
  const channelOf = (conversation: Conversation) =>
    channels.get(conversation.connection) as Channel;
  const retrieve = createRetriever(channelOf);
  const eligible = (conversation: Conversation) =>
    mayAnswer(settings.ownershipPolicy, conversation.state);
  const gateway = createOpenRouter(settings.gateway);
  const prepare = createPreparer({
    settings,
    skills,
    retrieve,
    handoff: (conversation, reason, turn) =>
      handoff(conversation, channelOf(conversation), {
        kind: "out-of-scope",
        reason,
        turn,
        byAgent: true,
      }),
    connectionTools: () => Promise.resolve({}),
  });
  const runner = createTurnRunner({
    settings,
    channelOf,
    model: gateway(settings.model),
    prepare,
    afterTurn: createAfterTurn({ channelOf, eligible }),
    nudgeInstruction: "Nudge",
  });
  return { retrieve, turns: createTurns(runner, eligible) };
}

type Runtime = ReturnType<typeof createRuntime>;

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

export async function startApp(
  source: EnvSource,
  fail: (error: unknown) => void,
) {
  const env = readEnv(source);
  const settings = parseSettings(env);
  const channels = readConnections(env);
  const { conversations, damaged } = await openStorage(settings.dataDir);
  const skills = createSkills(settings.skillsDir, settings.country);
  await skills.current();
  const runtime = createRuntime(settings, channels, skills);
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
  const health = async () => ({
    ready,
    connections: [...channels.keys()],
    damagedHistories: damaged,
    skillProblems: await skills
      .problems()
      .catch((error: unknown) => [errorText(error)]),
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
