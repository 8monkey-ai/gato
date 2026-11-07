import type { JSONSchema7 } from "ai";

import type { ToolScope } from "../../tools/mcp.ts";

export const defaultTools = [
  "get_contact",
  "create_comment",
  "add_contact_tags",
  "update_contact",
];
export const defaultEditableFields = ["firstName", "lastName", "language"];

const beyondContact = new Set([
  "list_contacts",
  "merge_contacts",
  "create_contact",
  "send_message",
]);
const fieldTools = new Set(["update_contact", "create_or_update_contact"]);
const tagTools = new Set(["add_contact_tags", "remove_contact_tags"]);

export function checkPermittedTools(tools: readonly string[]) {
  const refused = tools.filter((tool) => beyondContact.has(tool));
  if (refused.length) {
    throw new Error(
      `These respond.io MCP tools reach beyond the current contact: ${refused.join(", ")}`,
    );
  }
}

export function contactScope(
  contact: string,
  policy: { editableFields: readonly string[]; labels: readonly string[] },
): ToolScope {
  return ({ name, inputSchema }) => {
    const properties = { ...(inputSchema.properties ?? {}) } as Record<
      string,
      JSONSchema7
    >;
    delete properties.identifier;
    if (fieldTools.has(name)) {
      for (const field of Object.keys(properties)) {
        if (!policy.editableFields.includes(field)) delete properties[field];
      }
    }
    if (tagTools.has(name))
      properties.tags = { type: "array", items: { enum: [...policy.labels] } };
    const allowed = new Set(Object.keys(properties));
    return {
      inputSchema: {
        ...inputSchema,
        properties,
        required: (inputSchema.required ?? []).filter((key) =>
          allowed.has(key),
        ),
      },
      prepare(input) {
        const refused = Object.keys(input).filter((key) => !allowed.has(key));
        if (refused.length)
          throw new Error(`Not permitted: ${refused.join(", ")}`);
        const tags = Array.isArray(input.tags) ? (input.tags as unknown[]) : [];
        const unknownTags = tags.filter(
          (tag) => !policy.labels.includes(String(tag)),
        );
        if (unknownTags.length)
          throw new Error(
            `These labels are not permitted: ${unknownTags.join(", ")}`,
          );
        return { ...input, identifier: `id:${contact}` };
      },
    };
  };
}
