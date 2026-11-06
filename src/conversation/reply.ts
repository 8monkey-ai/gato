import { stepCountIs, streamText } from "ai";

import { buildContext } from "../agent/context.ts";
import { composeInstructions, localDate } from "../agent/instructions.ts";
import type { Budget, ModelFactory } from "../agent/models.ts";
import {
  handoffTool,
  readSkillTool,
  type ToolActivity,
  toToolSet,
} from "../agent/tools.ts";
import {
  type Preparation,
  prepareAttachments,
} from "../attachments/prepare.ts";
import type { AgentTool, Channel } from "../channels/channel.ts";
import type { Delivery } from "../delivery/deliver.ts";
import { createSegmenter } from "../delivery/segmenter.ts";
import { log } from "../log.ts";
import type { Prompts } from "../prompts.ts";
import type { MessageEntry } from "../record/entries.ts";
import type { Chat } from "../record/store.ts";
import type { SkillsCheckout } from "../skills/checkout.ts";
import type { Country } from "../skills/country.ts";
import { summaryForTurn } from "../summary/summarize.ts";
import { addNote } from "./notes.ts";

interface ReplySettings {
  country: Country;
  timezone: string;
  prompts: Prompts;
  agentModel: string;
  summaryModel?: string;
  preparationModels: Preparation["models"];
  maxModelCalls: number;
  boundary: string;
}

export interface ReplyDeps {
  settings: ReplySettings;
  models: ModelFactory;
  skills: SkillsCheckout;
  businessTools: AgentTool[];
}

interface ReplyJob {
  chat: Chat;
  channel: Channel;
  turn: string;
  nudge: boolean;
  budget: Budget;
  signal: AbortSignal;
  delivery: Delivery;
}

const skipMarker = "NO_REPLY";

/** Holds back output that starts with the skip marker, so a skip explanation stays private. */
function skipGate(delivery: Delivery) {
  const state = { first: true, skipped: undefined as string | undefined };
  return {
    state,
    push: (part: string) => {
      if (state.first) {
        state.first = false;
        if (part.startsWith(skipMarker)) {
          state.skipped = part.slice(skipMarker.length).replace(/^:\s*/, "");
          return;
        }
      }
      if (state.skipped === undefined) delivery.push(part);
    },
  };
}

async function turnTools(deps: ReplyDeps, job: ReplyJob) {
  const { chat, channel, turn } = job;
  const skills = await deps.skills.current();
  const handOff = async (reason: string) => {
    await addNote(chat, channel, {
      author: "agent",
      kind: "handoff",
      text: reason,
      turn,
    });
    await channel.handOff?.(chat.id, "out-of-scope");
  };
  const tools = [
    readSkillTool(skills),
    ...(channel.handOff ? [handoffTool(handOff)] : []),
    ...(channel.tools?.(chat.id) ?? []),
    ...deps.businessTools,
  ];
  const record = async (activity: ToolActivity) => {
    log[activity.error ? "warn" : "info"]("tool.called", {
      conversation: chat.id,
      turn,
      tool: activity.name,
      error: activity.error,
    });
    await chat.add({
      type: "tool",
      at: new Date().toISOString(),
      turn,
      ...activity,
    });
  };
  return { skills, tools: toToolSet(tools, record) };
}

async function prepareContext(deps: ReplyDeps, job: ReplyJob, now: Date) {
  const { settings, models } = deps;
  const model = (id: string) => models(id, job.budget);
  const summary = await summaryForTurn({
    chat: job.chat,
    now,
    timezone: settings.timezone,
    prompt: settings.prompts.summary,
    model: model(settings.summaryModel ?? settings.agentModel),
    signal: job.signal,
  });
  await prepareAttachments({
    chat: job.chat,
    channel: job.channel,
    preparation: {
      models: settings.preparationModels,
      prompts: settings.prompts,
      model,
    },
    signal: job.signal,
  });
  return buildContext({
    entries: job.chat.entries,
    files: { read: (file) => job.chat.readAttachment(file) },
    summary: summary && {
      date: localDate(summary.date, settings.timezone),
      text: summary.text,
    },
    nudgePrompt: job.nudge ? settings.prompts.nudge : undefined,
  });
}

function customerName(job: ReplyJob): string | undefined {
  return job.chat.entries.findLast(
    (entry): entry is MessageEntry =>
      entry.type === "message" && entry.role === "customer",
  )?.sender;
}

/** Streams the reply into delivery. Returns the private skip reason when the agent skips. */
export async function generateReply(
  deps: ReplyDeps,
  job: ReplyJob,
): Promise<{ skipped?: string }> {
  const now = new Date();
  const { skills, tools } = await turnTools(deps, job);
  const messages = await prepareContext(deps, job, now);
  const instructions = composeInstructions({
    base: deps.settings.prompts.agent,
    skills,
    country: deps.settings.country,
    timezone: deps.settings.timezone,
    now,
    customerName: customerName(job),
    canHandOff: job.channel.handOff !== undefined,
  });
  const gate = skipGate(job.delivery);
  const segmenter = createSegmenter(deps.settings.boundary, gate.push);
  const result = streamText({
    model: deps.models(deps.settings.agentModel, job.budget),
    instructions,
    messages,
    tools,
    stopWhen: stepCountIs(deps.settings.maxModelCalls + 1),
    abortSignal: job.signal,
  });
  try {
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") segmenter.push(part.text);
      else if (part.type === "text-end") segmenter.flush();
      else if (part.type === "error") throw part.error;
      else if (part.type === "abort") throw job.signal.reason;
    }
  } finally {
    segmenter.flush();
  }
  return { skipped: gate.state.skipped };
}
