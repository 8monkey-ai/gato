import type { McpConnection } from "../../mcp/connection.ts";
import type { AgentTool } from "../channel.ts";

interface RespondioToolPolicy {
  editableFields: string[];
  labels: string[];
}

const fieldTools = new Set(["update_contact", "create_or_update_contact"]);

interface ObjectSchema {
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

function scopedSchema(
  name: string,
  original: Record<string, unknown>,
  policy: RespondioToolPolicy,
): ObjectSchema {
  const schema = original as ObjectSchema;
  const properties = { ...schema.properties };
  delete properties.identifier;
  if (fieldTools.has(name))
    for (const field of Object.keys(properties))
      if (!policy.editableFields.includes(field)) delete properties[field];
  const required = (schema.required ?? []).filter(
    (field) => field in properties,
  );
  return { ...schema, properties, required };
}

function check(
  name: string,
  input: Record<string, unknown>,
  schema: ObjectSchema,
  policy: RespondioToolPolicy,
) {
  const extra = Object.keys(input).filter(
    (key) => !(key in (schema.properties ?? {})),
  );
  if (extra.length)
    throw new Error(`not permitted: ${name} cannot change ${extra.join(", ")}`);
  if (name === "add_contact_tags") {
    const tags = Array.isArray(input.tags) ? input.tags.map(String) : [];
    const denied = tags.filter((tag) => !policy.labels.includes(tag));
    if (denied.length)
      throw new Error(
        `not permitted: labels ${denied.join(", ")} are not allowed`,
      );
  }
}

const fieldNote =
  " Use it only with values that the customer explicitly gave or confirmed. Never infer them.";

function properties(schema: Record<string, unknown>) {
  return (schema as ObjectSchema).properties ?? {};
}

/** Throws for tools that cannot be limited to the current contact, so such a permission is refused. */
export function checkContactScope(connection: McpConnection) {
  const unscoped = connection.tools.filter(
    (tool) => !("identifier" in properties(tool.inputSchema)),
  );
  if (unscoped.length)
    throw new Error(
      `RESPONDIO_MCP_TOOLS: ${unscoped.map((t) => t.name).join(", ")} cannot be limited to the current contact`,
    );
}

/** The contact identifier comes from the conversation, never from the model. */
export function contactTools(
  connection: McpConnection,
  contactId: string,
  policy: RespondioToolPolicy,
): AgentTool[] {
  return connection.tools.map((tool) => {
    const schema = scopedSchema(tool.name, tool.inputSchema, policy);
    return {
      name: `respondio_${tool.name}`,
      description: `${tool.description} Applies to the current contact only.${fieldTools.has(tool.name) ? fieldNote : ""}`,
      parameters: schema,
      execute: ({ identifier: _ignored, ...input }, signal) => {
        check(tool.name, input, schema, policy);
        return connection.call(
          tool.name,
          { ...input, identifier: `id:${contactId}` },
          signal,
        );
      },
    };
  });
}
