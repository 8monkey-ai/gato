import { expect, test } from "bun:test";

import type { McpClient } from "../../tools/mcp-client.ts";
import { createContactTools } from "./contact-tools.ts";

const signal = new AbortController().signal;
const identifier = { type: "string", description: "The contact's identifier." };

const schema = (properties: Record<string, unknown>) => ({
  type: "object",
  properties: { identifier, ...properties },
  required: ["identifier", ...Object.keys(properties)],
});

const serverTools = [
  {
    name: "get_contact",
    description: "Get a contact.",
    inputSchema: schema({}),
  },
  {
    name: "add_contact_tags",
    description: "Add tags to a contact.",
    inputSchema: schema({ tags: { type: "array" } }),
  },
  {
    name: "update_contact",
    description: "Update a contact.",
    inputSchema: schema({ firstName: { type: "string" } }),
  },
  {
    name: "update_conversation_status",
    description: "Open or close a conversation.",
    inputSchema: schema({ status: { type: "string" } }),
  },
  {
    name: "merge_contacts",
    description: "Merge two contacts.",
    inputSchema: {
      type: "object",
      properties: {
        primaryContactId: { type: "number" },
        secondaryContactId: { type: "number" },
      },
    },
  },
  {
    name: "list_contacts",
    description: "List contacts.",
    inputSchema: { type: "object", properties: { limit: {} } },
  },
  {
    name: "tag_contacts",
    description: "Tag many contacts.",
    inputSchema: schema({ contactIds: { type: "array" } }),
  },
];

function fakeClient() {
  const calls: [string, unknown][] = [];
  const client: Pick<McpClient, "tools" | "call"> = {
    tools: () => Promise.resolve(serverTools),
    call: (name, args) => {
      calls.push([name, args]);
      return Promise.resolve({ isError: false, output: "done" });
    },
  };
  return { client, calls };
}

const policy = {
  tools: ["get_contact", "add_contact_tags", "update_contact"],
  editableFields: ["firstName", "lastName", "language"],
  labels: ["handoff", "out-of-scope", "vip"],
  statusChanges: [],
};

async function toolsFor(chatId: string, override = {}) {
  const { client, calls } = fakeClient();
  const tools = await (
    await createContactTools(client, { ...policy, ...override })
  )(chatId);
  const run = (name: string, input: unknown) =>
    tools.find((tool) => tool.name === name)!.execute(input, signal);
  return { tools, run, calls };
}

test("offers permitted tools without contact identifiers in the schema", async () => {
  const { tools } = await toolsFor("12");
  expect(
    tools.map((tool) => [tool.name, tool.description, tool.inputSchema]),
  ).toEqual([
    [
      "respondio_get_contact",
      "Get a contact.",
      { type: "object", properties: {}, required: [] },
    ],
    [
      "respondio_add_contact_tags",
      "Add tags to a contact.",
      {
        type: "object",
        properties: { tags: { type: "array" } },
        required: ["tags"],
      },
    ],
    [
      "respondio_update_contact",
      "Update a contact. Use only with values the customer supplied or confirmed explicitly. Never infer them.",
      {
        type: "object",
        properties: { firstName: { type: "string" } },
        required: ["firstName"],
      },
    ],
  ]);
});

test("injects the current contact identifier", async () => {
  const { run, calls } = await toolsFor("12");
  expect(await run("respondio_get_contact", {})).toEqual({
    isError: false,
    output: "done",
  });
  await run("respondio_get_contact", { identifier: "id:12" });
  expect(calls).toEqual([
    ["get_contact", { identifier: "id:12" }],
    ["get_contact", { identifier: "id:12" }],
  ]);
});

test("rejects another contact", async () => {
  const { run, calls } = await toolsFor("12");
  expect(await run("respondio_get_contact", { identifier: "id:13" })).toEqual({
    isError: true,
    output: "Not permitted: only the current contact is allowed",
  });
  expect(await run("respondio_get_contact", { contactId: 13 })).toMatchObject({
    isError: true,
  });
  expect(
    await run("respondio_get_contact", { identifier: "phone:+601" }),
  ).toMatchObject({
    isError: true,
  });
  expect(calls).toEqual([]);
});

test("adds only configured labels", async () => {
  const { run, calls } = await toolsFor("12");
  expect(
    await run("respondio_add_contact_tags", { tags: ["handoff", "refund"] }),
  ).toEqual({
    isError: true,
    output: "Not permitted: tags must be from: handoff, out-of-scope, vip",
  });
  await run("respondio_add_contact_tags", { tags: ["vip"] });
  expect(calls).toEqual([
    ["add_contact_tags", { tags: ["vip"], identifier: "id:12" }],
  ]);
});

test("edits only configured fields", async () => {
  const { run, calls } = await toolsFor("12");
  expect(
    await run("respondio_update_contact", { firstName: "Ana", phone: "+601" }),
  ).toEqual({
    isError: true,
    output: "Not permitted: fields not editable: phone",
  });
  await run("respondio_update_contact", {
    identifier: "id:12",
    language: "ms",
  });
  expect(calls).toEqual([
    ["update_contact", { identifier: "id:12", language: "ms" }],
  ]);
});

test("refuses status changes until they are configured", async () => {
  const tools = ["update_conversation_status"];
  const disabled = await toolsFor("12", { tools });
  expect(
    await disabled.run("respondio_update_conversation_status", {
      status: "close",
    }),
  ).toEqual({
    isError: true,
    output: "Not permitted: conversation status changes are disabled",
  });
  const enabled = await toolsFor("12", { tools, statusChanges: ["open"] });
  expect(
    await enabled.run("respondio_update_conversation_status", {
      status: "close",
    }),
  ).toEqual({
    isError: true,
    output: "Not permitted: status must be one of: open",
  });
  await enabled.run("respondio_update_conversation_status", { status: "open" });
  expect(enabled.calls).toEqual([
    ["update_conversation_status", { status: "open", identifier: "id:12" }],
  ]);
});

test("a permitted tool the server does not offer fails at creation", async () => {
  const { client } = fakeClient();
  await expect(
    createContactTools(client, { ...policy, tools: ["delete_contact"] }),
  ).rejects.toThrow(
    "respond.io MCP server does not offer the permitted tools: delete_contact",
  );
});

test("a permitted tool that can reach other contacts fails at creation", async () => {
  const { client } = fakeClient();
  const tools = [
    "get_contact",
    "merge_contacts",
    "list_contacts",
    "tag_contacts",
  ];
  await expect(
    createContactTools(client, { ...policy, tools }),
  ).rejects.toThrow(
    "respond.io MCP tools cannot be limited to the current contact: merge_contacts, list_contacts, tag_contacts",
  );
});
