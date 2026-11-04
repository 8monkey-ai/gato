import { z } from "zod";

import type { McpClient, McpToolInfo } from "../../tools/mcp-client.ts";
import { type InputTransform, mcpAgentTools } from "../../tools/mcp-tools.ts";
import type { McpSettings } from "./settings.ts";

type Policy = Pick<
  McpSettings,
  "tools" | "editableFields" | "labels" | "statusChanges"
>;
type Input = Record<string, unknown>;
type Rule = (input: Input, policy: Policy) => string | undefined;

const contactKeys = ["identifier", "contactId"];
const inputObject = z.record(z.string(), z.unknown());
const toolSchema = z.looseObject({
  properties: inputObject.optional(),
  required: z.array(z.string()).optional(),
});

const rules: Record<string, Rule> = {
  add_contact_tags: ({ tags }, { labels }) =>
    Array.isArray(tags) &&
    tags.every((tag) => typeof tag === "string" && labels.includes(tag))
      ? undefined
      : `tags must be from: ${labels.join(", ")}`,
  update_contact: (input, { editableFields }) => {
    const fields = Object.keys(input).filter(
      (key) => !contactKeys.includes(key) && !editableFields.includes(key),
    );
    return fields.length === 0
      ? undefined
      : `fields not editable: ${fields.join(", ")}`;
  },
  update_conversation_status: ({ status }, { statusChanges }) => {
    if (statusChanges.length === 0)
      return "conversation status changes are disabled";
    return typeof status === "string" && statusChanges.includes(status)
      ? undefined
      : `status must be one of: ${statusChanges.join(", ")}`;
  },
};

const notes: Record<string, string> = {
  update_contact:
    "Use only with values the customer supplied or confirmed explicitly. Never infer them.",
};

function forModel(tool: McpToolInfo): McpToolInfo {
  const schema = toolSchema.parse(tool.inputSchema);
  const visible = (key: string) => !contactKeys.includes(key);
  const note = notes[tool.name];
  return {
    ...tool,
    description: note ? `${tool.description} ${note}`.trim() : tool.description,
    inputSchema: {
      ...schema,
      properties: Object.fromEntries(
        Object.entries(schema.properties ?? {}).filter(([key]) => visible(key)),
      ),
      ...(schema.required && { required: schema.required.filter(visible) }),
    },
  };
}

function isOtherContact(value: unknown, chatId: string) {
  if (value === undefined) return false;
  const text =
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  return text !== chatId && text !== `id:${chatId}`;
}

function checker(chatId: string, policy: Policy): InputTransform {
  return (name, input) => {
    const fields = inputObject.safeParse(input).data;
    if (!fields) return { ok: false, reason: "input must be a JSON object" };
    const reason = contactKeys.some((key) =>
      isOtherContact(fields[key], chatId),
    )
      ? "only the current contact is allowed"
      : rules[name]?.(fields, policy);
    if (reason) return { ok: false, reason };
    return { ok: true, input: { ...fields, identifier: `id:${chatId}` } };
  };
}

export async function createContactTools(
  client: Pick<McpClient, "tools" | "call">,
  policy: Policy,
) {
  const offered = (await client.tools()).map(forModel);
  const cached = {
    tools: () => Promise.resolve(offered),
    call: client.call.bind(client),
  };
  const toolsFor = (chatId: string) =>
    mcpAgentTools(cached, {
      prefix: "respondio",
      permitted: policy.tools,
      transformInput: checker(chatId, policy),
    });
  // Fails startup when the server does not offer a permitted tool.
  await toolsFor("");
  return toolsFor;
}
