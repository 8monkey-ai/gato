import { type EnvReader, parseList } from "../../config/env.ts";
import { readLabels } from "../../config/settings.ts";

export type RespondioSettings = ReturnType<typeof readRespondioSettings>;
export type McpSettings = NonNullable<RespondioSettings["mcp"]>;

const statusChanges = ["open", "close"];

function parseNonEmptyList(raw: string) {
  const items = parseList(raw);
  return items.length > 0 ? items : undefined;
}

function parseStatusChanges(raw: string) {
  const items = parseList(raw);
  return items.every((item) => statusChanges.includes(item))
    ? items
    : undefined;
}

function readMcp(env: EnvReader) {
  if (!env.bool("MCP_ENABLED", { default: false })) return undefined;
  const labels = readLabels(env.root());
  return {
    url: env.string("MCP_URL", { default: "https://mcp.respond.io/mcp" }),
    token: env.string("MCP_TOKEN"),
    tools: env.list("MCP_TOOLS", {
      default: [
        "get_contact",
        "create_comment",
        "add_contact_tags",
        "update_contact",
      ],
    }),
    editableFields: env.list("MCP_EDITABLE_FIELDS", {
      default: ["firstName", "lastName", "language"],
    }),
    labels: [
      labels.handoff,
      labels.outOfScope,
      ...env.list("MCP_EXTRA_LABELS", { default: [] }),
    ],
    statusChanges: env.custom(
      "MCP_STATUS_CHANGES",
      "a comma separated list of open, close",
      parseStatusChanges,
      [],
    ),
  };
}

export function readRespondioSettings(env: EnvReader) {
  return {
    apiToken: env.string("API_TOKEN"),
    signingKeys: env.custom(
      "SIGNING_KEYS",
      "a comma separated list of webhook signing keys",
      parseNonEmptyList,
    ),
    agentUserId: String(env.int("AGENT_USER_ID")),
    channelId:
      env.optionalString("CHANNEL_ID") === undefined
        ? undefined
        : env.int("CHANNEL_ID"),
    apiUrl: env.string("API_URL", { default: "https://api.respond.io/v2" }),
    maxTextLength: env.int("MAX_TEXT_LENGTH", { default: 4096 }),
    mcp: readMcp(env),
  };
}
