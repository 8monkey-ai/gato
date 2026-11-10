import { type Env, envList } from "../../env.ts";
import { protectSecret } from "../../log.ts";
import type { McpServer } from "../../tools/mcp.ts";
import {
  checkPermittedTools,
  defaultEditableFields,
  defaultTools,
} from "./mcp-scope.ts";

export type Settings = ReturnType<typeof settingsOf>;

export function settingsOf(env: Env, name: string) {
  if (!/^[a-z0-9]+$/.test(name))
    throw new Error(
      `respond.io workspace name "${name}" must be letters and digits`,
    );
  const prefix = `RESPONDIO_${name.toUpperCase()}`;
  const value = (key: string) => env[`${prefix}_${key}`];
  const required = (key: string) => {
    const found = value(key);
    if (!found)
      throw new Error(
        `${prefix}_${key} is required for respond.io workspace "${name}"`,
      );
    protectSecret(found);
    return found;
  };
  const number = (key: string) => {
    const found = value(key);
    if (found && !/^\d+$/.test(found))
      throw new Error(`${prefix}_${key} must be a number`);
    return found ? Number(found) : undefined;
  };
  const labels = {
    handoff: value("HANDOFF_LABEL") ?? "handoff",
    "out-of-scope": value("OUT_OF_SCOPE_LABEL") ?? "out-of-scope",
    error: value("ERROR_LABEL") ?? "error",
  };
  return {
    name,
    apiUrl: env.RESPONDIO_API_URL ?? "https://api.respond.io/v2",
    apiToken: required("API_TOKEN"),
    signingKeys: envList(required("WEBHOOK_SIGNING_KEYS")).map((key) => {
      protectSecret(key);
      return key;
    }),
    agentUserId: number("AGENT_USER_ID"),
    replyChannelId: number("REPLY_CHANNEL_ID"),
    labels,
    mcp: value("MCP_URL") ? mcpSettings(value, required, labels) : undefined,
  };
}

function mcpSettings(
  value: (key: string) => string | undefined,
  required: (key: string) => string,
  labels: Record<"handoff" | "out-of-scope", string>,
) {
  const listOr = (key: string, fallback: string[]) => {
    const found = envList(value(`MCP_${key}`));
    return found.length ? found : fallback;
  };
  const server: McpServer = {
    name: "respondio",
    url: required("MCP_URL"),
    headers: { authorization: `Bearer ${required("MCP_BEARER_TOKEN")}` },
    tools: listOr("TOOLS", defaultTools),
  };
  checkPermittedTools(server.tools);
  return {
    server,
    editableFields: listOr("EDITABLE_FIELDS", defaultEditableFields),
    labels: listOr("LABELS", [labels.handoff, labels["out-of-scope"]]),
  };
}
