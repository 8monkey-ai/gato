import {
  type LanguageModel,
  stepCountIs,
  streamText,
  type TextStreamPart,
  type ToolSet,
} from "ai";

import type { Connection } from "../channels/channel.ts";
import type { Config } from "../config.ts";
import type { createDelivery } from "../delivery/deliver.ts";
import { createPartSplitter } from "../delivery/parts.ts";
import { log, redact } from "../log.ts";
import type { Trigger } from "../record/chat-file.ts";
import type { Conversation } from "../record/store.ts";
import {
  type Instructions,
  loadInstructions,
  skillCatalogue,
} from "../skills/skills.ts";
import type { McpServer } from "../tools/mcp.ts";
import { buildContext } from "./context.ts";
import type { Budget, createGateway } from "./models.ts";
import { createPreparer } from "./preparation.ts";
import { fillTemplate, type Prompts } from "./prompts.ts";
import { contactSummary } from "./summary.ts";
import { openTools } from "./tools.ts";

export type AgentDeps = {
  config: Config;
  prompts: Prompts;
  gateway: ReturnType<typeof createGateway>;
  mcpServers: readonly McpServer[];
};

export type Turn = {
  id: string;
  conversation: Conversation;
  connection: Connection;
  trigger: Trigger;
  budget: Budget;
  model: (modelId: string, callType: string) => LanguageModel;
  delivery: ReturnType<typeof createDelivery>;
};

export async function generate(deps: AgentDeps, turn: Turn): Promise<boolean> {
  const { config, prompts } = deps;
  const { conversation, connection, budget } = turn;
  const instructions = await loadInstructions(config.skillsDir, config.country);
  reportProblems(instructions.problems);
  const messages = await turnMessages(deps, turn);
  const tools = await openTools({
    instructions,
    prompts,
    conversation,
    connection,
    mcpServers: deps.mcpServers,
  });
  try {
    const result = streamText({
      model: turn.model(
        config.models.agent,
        turn.trigger === "nudge" ? "nudge" : "message",
      ),
      instructions: systemPrompt(deps, connection, instructions),
      messages,
      tools: tools.tools,
      // The budget stops the turn at the limit and reports it; a lower stop would hide that.
      stopWhen: stepCountIs(config.turn.maxModelCalls + 1),
      abortSignal: budget.signal,
    });
    return await consume(result.stream, turn, config.delivery.boundary);
  } finally {
    await tools.close();
  }
}

async function turnMessages({ config, prompts }: AgentDeps, turn: Turn) {
  const { conversation, connection, budget } = turn;
  const summary = await contactSummary(conversation, {
    model: turn.model(config.models.summary, "summary"),
    prompt: prompts.summary,
    timezone: config.timezone,
    signal: budget.signal,
  });
  const prepare = createPreparer({
    models: config.models.preparation,
    prompts,
    model: (modelId) => turn.model(modelId, "preparation"),
    signal: budget.signal,
    conversation,
  });
  const messages = await buildContext(
    conversation,
    connection,
    prepare,
    summary,
  );
  // Model gateways refuse a request that ends with an assistant message.
  const endsWithTeam = messages.at(-1)?.role === "assistant";
  const trigger =
    turn.trigger === "nudge"
      ? prompts.nudge
      : endsWithTeam
        ? prompts.continue
        : undefined;
  if (trigger) messages.push({ role: "user", content: trigger });
  return messages;
}

function systemPrompt(
  { config, prompts }: AgentDeps,
  connection: Connection,
  instructions: Instructions,
) {
  return fillTemplate(prompts.conversation, {
    channel: connection.label,
    today: new Intl.DateTimeFormat("en-GB", {
      timeZone: config.timezone,
      dateStyle: "full",
    }).format(),
    timezone: config.timezone,
    message_boundary: JSON.stringify(config.delivery.boundary).slice(1, -1),
    business_instructions: instructions.business,
    skills: skillCatalogue(instructions),
  });
}

async function consume(
  stream: AsyncIterable<TextStreamPart<ToolSet>>,
  turn: Turn,
  boundary: string,
) {
  let generated = false;
  const splitter = createPartSplitter(boundary, (part) => {
    generated = true;
    turn.delivery.enqueue(part);
  });
  try {
    for await (const part of stream) {
      if (part.type === "text-delta") splitter.push(part.text);
      if (part.type === "text-end") splitter.flush();
      if (part.type === "tool-result" || part.type === "tool-error")
        await recordTool(turn, part);
      if (part.type === "error") throw part.error;
    }
    splitter.flush();
  } catch (error) {
    const unsent = splitter.pending();
    if (unsent) await turn.delivery.recordUnsent(unsent);
    throw error;
  }
  return generated;
}

async function recordTool(
  turn: Turn,
  part: Extract<
    TextStreamPart<ToolSet>,
    { type: "tool-result" | "tool-error" }
  >,
) {
  const failed = part.type === "tool-error";
  const result = failed
    ? { error: redact(String(part.error)) }
    : { output: part.output as unknown };
  log.info("tool.called", {
    contact: turn.conversation.contact,
    turn: turn.id,
    tool: part.toolName,
    failed,
  });
  await turn.conversation.lock(async (edit) => {
    edit.add({
      kind: "tool",
      at: new Date().toISOString(),
      turn: turn.id,
      name: part.toolName,
      ...(failed ? { failed } : {}),
      text: JSON.stringify({ input: part.input as unknown, ...result }),
    });
    await edit.save();
  });
}

let reportedProblems = "";

function reportProblems(problems: string[]) {
  const current = problems.join("\n");
  if (current && current !== reportedProblems)
    log.warn("skills.problems", { problems });
  reportedProblems = current;
}
