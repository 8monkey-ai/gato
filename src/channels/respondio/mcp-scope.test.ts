import { expect, test } from "bun:test";

import { checkPermittedTools, contactScope } from "./mcp-scope.ts";

const scope = contactScope("5", {
  editableFields: ["firstName", "language"],
  labels: ["handoff"],
});

test("forces the current contact and hides the identifier", () => {
  const scoped = scope({
    name: "get_contact",
    inputSchema: {
      type: "object",
      properties: { identifier: { type: "string" } },
      required: ["identifier"],
    },
  });
  expect(scoped.inputSchema).toEqual({
    type: "object",
    properties: {},
    required: [],
  });
  expect(scoped.prepare({})).toEqual({ identifier: "id:5" });
  expect(() => scoped.prepare({ identifier: "id:6" })).toThrow();
});

test("limits editable fields and labels", () => {
  const update = scope({
    name: "update_contact",
    inputSchema: {
      type: "object",
      properties: { identifier: {}, firstName: {}, email: {}, language: {} },
    },
  });
  expect(Object.keys(update.inputSchema.properties ?? {})).toEqual([
    "firstName",
    "language",
  ]);
  expect(() => update.prepare({ email: "a@b.c" })).toThrow();

  const tags = scope({
    name: "add_contact_tags",
    inputSchema: { type: "object", properties: { tags: {} } },
  });
  expect(tags.prepare({ tags: ["handoff"] })).toEqual({
    tags: ["handoff"],
    identifier: "id:5",
  });
  expect(() => tags.prepare({ tags: ["vip"] })).toThrow();
});

test("refuses tools that reach other contacts", () => {
  expect(() => checkPermittedTools(["get_contact", "list_contacts"])).toThrow();
  expect(() => checkPermittedTools(["get_contact"])).not.toThrow();
});
