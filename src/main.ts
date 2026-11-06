import { checkModels, createModels } from "./agent/models.ts";
import type { Channel } from "./channels/channel.ts";
import { createChannels } from "./channels/index.ts";
import { type Config, readConfig } from "./config.ts";
import { Conversations } from "./conversation/service.ts";
import type { TurnDeps } from "./conversation/turn.ts";
import { serveHttp } from "./http.ts";
import { errorText, log } from "./log.ts";
import { McpConnection } from "./mcp/connection.ts";
import { checkNudges, scheduleNudges } from "./nudges/scheduler.ts";
import { loadPrompts } from "./prompts.ts";
import { ChatStore } from "./record/store.ts";
import { SkillsCheckout } from "./skills/checkout.ts";

const status = {
  ready: false,
  nudges: "waiting" as "waiting" | "ready" | "disabled",
  skillProblems: [] as string[],
};

async function prepare(config: Config) {
  const prompts = await loadPrompts();
  const store = await ChatStore.open(config.DATA_DIR);
  for (const chat of store.damaged) log.error("chat.damaged", { ...chat });
  const skills = new SkillsCheckout(
    config.SKILLS_DIR,
    config.COUNTRY,
    (problems) => {
      status.skillProblems = problems;
      for (const problem of problems) log.warn("skills.problem", { problem });
    },
  );
  await skills.current();
  const models = [
    config.AGENT_MODEL,
    config.SUMMARY_MODEL,
    config.IMAGE_PREPARATION_MODEL,
    config.DOCUMENT_PREPARATION_MODEL,
    config.AUDIO_PREPARATION_MODEL,
  ].filter((id): id is string => id !== undefined);
  await checkModels(config.OPENROUTER_BASE_URL, models);
  const mcp = await Promise.all(
    config.MCP_SERVERS.map((server) =>
      McpConnection.connect({
        server: server.name,
        url: server.url,
        headers: server.headers,
        permitted: server.tools,
      }),
    ),
  );
  return { prompts, store, skills, mcp };
}

function turnDeps(
  config: Config,
  prepared: Awaited<ReturnType<typeof prepare>>,
): TurnDeps {
  return {
    settings: {
      country: config.COUNTRY,
      timezone: config.TIMEZONE,
      prompts: prepared.prompts,
      agentModel: config.AGENT_MODEL,
      summaryModel: config.SUMMARY_MODEL,
      preparationModels: {
        image: config.IMAGE_PREPARATION_MODEL,
        document: config.DOCUMENT_PREPARATION_MODEL,
        audio: config.AUDIO_PREPARATION_MODEL,
      },
      maxModelCalls: config.TURN_MAX_MODEL_CALLS,
      boundary: config.DELIVERY_MESSAGE_BOUNDARY,
    },
    models: createModels(config.OPENROUTER_API_KEY, config.OPENROUTER_BASE_URL),
    skills: prepared.skills,
    businessTools: prepared.mcp.flatMap((connection) =>
      connection.agentTools(),
    ),
    delivery: {
      pacing: config.DELIVERY_PACING,
      secondsPerWord: config.DELIVERY_TYPING_SECONDS_PER_WORD,
      video: {
        links: config.DELIVERY_VIDEO_LINKS,
        surroundingText: config.DELIVERY_VIDEO_LINK_TEXT,
        approvedUrls: config.DELIVERY_APPROVED_VIDEO_URLS,
      },
    },
    timeoutMs: config.TURN_TIMEOUT_SECONDS,
  };
}

async function main() {
  const config = readConfig(process.env);
  const channels: Channel[] = createChannels(config.CHANNELS, process.env);
  const prepared = await prepare(config);
  const conversations = new Conversations(
    prepared.store,
    turnDeps(config, prepared),
  );
  const server = serveHttp(config.PORT, channels, () => ({
    ...status,
    channels: channels.map((channel) => channel.name),
    damagedChats: prepared.store.damaged.length,
  }));
  for (const channel of channels)
    await channel.start(conversations.sink(channel));
  await conversations.resume(channels);
  const nudgeSettings = {
    intervalMs: config.NUDGE_CHECK_INTERVAL_SECONDS,
    milestones: config.NUDGE_MILESTONES,
    hours: config.NUDGE_HOURS,
    timezone: config.TIMEZONE,
  };
  const stopNudges = config.NUDGE_ENABLED
    ? scheduleNudges(
        () =>
          checkNudges(prepared.store, channels, conversations, nudgeSettings),
        nudgeSettings.intervalMs,
      )
    : undefined;
  status.nudges = config.NUDGE_ENABLED ? "ready" : "disabled";
  status.ready = true;
  log.info("harness.ready", {
    port: server.port,
    channels: config.CHANNELS.join(","),
  });

  const shutdown = async (signal: string) => {
    log.info("harness.stopping", { signal });
    status.ready = false;
    stopNudges?.();
    await Promise.all(channels.map((channel) => channel.stop()));
    await conversations.shutdown(config.SHUTDOWN_TIMEOUT_SECONDS);
    await Promise.all(prepared.mcp.map((connection) => connection.close()));
    await server.stop();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  log.error("harness.start_failed", { error: errorText(error) });
  process.exit(1);
});
