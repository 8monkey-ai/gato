import type { ToolSet } from "ai";

import type { Env } from "../../config/env.ts";
import { ConfigError } from "../../config/env.ts";
import type {
  McpConnection,
  McpToolDefinition,
  ObjectSchema,
} from "../../tools/mcp.ts";
import { connectMcp, mcpTool } from "../../tools/mcp.ts";

interface RespondMcpSettings {
  url: string;
  token: string;
  permitted: string[];
  labels: string[];
  fields: string[];
  statuses: string[];
}

type Args = Record<string, unknown>;

export function readMcpSettings(env: Env): RespondMcpSettings | undefined {
  const url = env.optional("MCP_URL");
  if (!url) return undefined;
  return {
    url,
    token: env.string("MCP_TOKEN"),
    permitted: env.list("MCP_TOOLS", [
      "get_contact",
      "create_comment",
      "add_contact_tags",
      "update_contact",
    ]),
    labels: env.list("MCP_LABELS", ["handoff", "out-of-scope"]),
    fields: env.list("MCP_FIELDS", ["firstName", "lastName", "language"]),
    statuses: env.list("MCP_STATUSES"),
  };
}

function outside(values: unknown, allowed: string[]) {
  const list: unknown[] = Array.isArray(values) ? values : [values];
  return list.filter((value) => !allowed.includes(String(value)));
}

function fieldsCheck(args: Args, settings: RespondMcpSettings) {
  const denied = outside(Object.keys(args), settings.fields);
  return denied.length > 0
    ? `Editing ${denied.join(", ")} is not permitted.`
    : undefined;
}

function labelsCheck(args: Args, settings: RespondMcpSettings) {
  const denied = outside(args.tags, settings.labels);
  return denied.length > 0
    ? `The labels ${denied.join(", ")} are not permitted.`
    : undefined;
}

function statusCheck(args: Args, settings: RespondMcpSettings) {
  return outside(args.status, settings.statuses).length > 0
    ? `The status change "${String(args.status)}" is not permitted.`
    : undefined;
}

const checks: Record<
  string,
  (args: Args, settings: RespondMcpSettings) => string | undefined
> = {
  update_contact: fieldsCheck,
  create_or_update_contact: fieldsCheck,
  create_contact: fieldsCheck,
  add_contact_tags: labelsCheck,
  remove_contact_tags: labelsCheck,
  update_conversation_status: statusCheck,
};

const profileNote =
  " Use only values that the customer supplied or confirmed in this conversation. Never infer them.";

function withoutIdentifier(schema: ObjectSchema): ObjectSchema {
  const { identifier: _, ...properties } = schema.properties ?? {};
  return {
    ...schema,
    properties,
    required: schema.required?.filter((name) => name !== "identifier"),
  };
}

function validate(definitions: McpToolDefinition[]) {
  for (const definition of definitions) {
    if (definition.name === "send_message") {
      throw new ConfigError(
        "The respond.io tool send_message is not permitted. Customer replies use the channel adapter.",
      );
    }
    if (!definition.inputSchema.properties?.identifier) {
      throw new ConfigError(
        `The respond.io tool ${definition.name} cannot be limited to the current contact.`,
      );
    }
  }
}

function scopedTool(
  definition: McpToolDefinition,
  connection: McpConnection,
  settings: RespondMcpSettings,
  chat: string,
) {
  const check = checks[definition.name];
  const profile = check === fieldsCheck;
  return mcpTool({
    description: `${definition.description ?? ""}${profile ? profileNote : ""} It acts only on the current contact.`,
    inputSchema: withoutIdentifier(definition.inputSchema),
    execute: async (args, signal) => {
      const denied = check?.(args, settings);
      if (denied) throw new Error(`${denied} The action was not applied.`);
      return await connection.call(
        definition.name,
        { ...args, identifier: `id:${chat}` },
        signal,
      );
    },
  });
}

export async function connectRespondMcp(
  connection: string,
  settings: RespondMcpSettings,
) {
  const mcp = await connectMcp({
    label: `The respond.io MCP server of "${connection}"`,
    ...settings,
  });
  validate(mcp.definitions);
  return (chat: string): ToolSet =>
    Object.fromEntries(
      mcp.definitions.map((definition) => [
        `${connection}__${definition.name}`,
        scopedTool(definition, mcp, settings, chat),
      ]),
    );
}
