import { afterEach, beforeEach, expect, test } from "bun:test";

import { launch, tempDir, waitFor } from "./support/app.ts";
import { useHarness } from "./support/fixture.ts";
import {
  afterTools,
  mainRequests,
  toolNames,
  toolResults,
} from "./support/gateway.ts";
import { FakeMcp, respondTools } from "./support/mcp.ts";
import { deliver, incoming } from "./support/respondio.ts";

const f = useHarness(["tg", "rio"]);
let kb: FakeMcp;
let rio: FakeMcp;

beforeEach(() => {
  kb = new FakeMcp([
    {
      name: "search",
      input: {},
      result: () => ({ text: "No matching policy" }),
    },
    {
      name: "broken",
      input: {},
      result: () => ({ text: "database down", isError: true }),
    },
    { name: "secret", input: {} },
  ]);
  rio = new FakeMcp(respondTools);
});

afterEach(async () => {
  await Promise.all([kb.stop(), rio.stop()]);
});

const kbEnv = () => ({
  MCP_SERVERS: "kb",
  MCP_KB_URL: kb.url,
  MCP_KB_TOKEN: "kb-token",
  MCP_KB_TOOLS: "search,broken",
});
const rioEnv = (extra: Record<string, string> = {}) => ({
  CONNECTION_RIO_MCP_URL: rio.url,
  CONNECTION_RIO_MCP_TOKEN: "rio-mcp-token",
  ...extra,
});

test("§9 a configured MCP server offers only its permitted tools, with bearer authentication and distinct names", async () => {
  f.gateway.reply(
    afterTools(
      { toolCalls: [{ name: "kb__search", args: {} }] },
      { text: "Answer" },
    ),
  );
  await f.start(kbEnv());
  f.telegram.customerMessage(1, { text: "Policy?" });
  await waitFor(() => f.telegram.sentTexts(1).length === 1);
  expect(toolNames(mainRequests(f.gateway)[0]!)).toEqual([
    "handoff_to_colleague",
    "kb__broken",
    "kb__search",
    "read_skill",
  ]);
  expect(kb.calls.map((call) => [call.name, call.authorization])).toEqual([
    ["search", "Bearer kb-token"],
  ]);
  expect(toolResults(mainRequests(f.gateway)[1]!).join()).toContain(
    "No matching policy",
  );
});

test("§9 a failed tool is reported as a failure, not as an invented result", async () => {
  f.gateway.reply(
    afterTools(
      { toolCalls: [{ name: "kb__broken", args: {} }] },
      { text: "Sorry" },
    ),
  );
  await f.start(kbEnv());
  f.telegram.customerMessage(1, { text: "Check" });
  await waitFor(() => f.telegram.sentTexts(1).length === 1);
  const result = toolResults(mainRequests(f.gateway)[1]!).join();
  expect(result).toContain("The tool broken failed: database down");
});

test("§9 an MCP server that becomes unavailable gives a tool failure", async () => {
  f.gateway.reply(
    afterTools(
      { toolCalls: [{ name: "kb__search", args: {} }] },
      { text: "Sorry" },
    ),
  );
  await f.start(kbEnv());
  await kb.stop();
  f.telegram.customerMessage(1, { text: "Check" });
  await waitFor(() => f.telegram.sentTexts(1).length === 1);
  expect(toolResults(mainRequests(f.gateway)[1]!).join()).toContain(
    "The tool search is unavailable",
  );
});

test("§10 an unavailable or incomplete MCP integration prevents readiness", async () => {
  const missing = launch({
    ...f.env(),
    ...kbEnv(),
    MCP_KB_TOOLS: "search,absent",
    DATA_DIR: await tempDir(),
  });
  expect(await missing.child.exited).toBe(1);
  await Bun.sleep(50);
  expect(missing.logs.join("\n")).toContain(
    'MCP server \\"kb\\" does not offer the permitted tools: absent.',
  );
  const clash = launch({
    ...f.env(),
    ...kbEnv(),
    MCP_SERVERS: "rio",
    MCP_RIO_URL: kb.url,
    MCP_RIO_TOOLS: "search",
    DATA_DIR: await tempDir(),
  });
  expect(await clash.child.exited).toBe(1);
});

test("§9 base respond.io tools are scoped to the current contact and absent from Telegram conversations", async () => {
  f.gateway.reply(
    afterTools(
      {
        toolCalls: [
          { name: "rio__get_contact", args: { identifier: "id:999" } },
        ],
      },
      { text: "Done" },
    ),
  );
  const app = await f.start(rioEnv());
  await deliver(app.url, incoming("61", { type: "text", text: "Who am I?" }));
  await waitFor(() => f.respond.sentTexts("61").length === 1);
  const request = mainRequests(f.gateway)[0]!;
  expect(toolNames(request).filter((name) => name.startsWith("rio__"))).toEqual(
    [
      "rio__add_contact_tags",
      "rio__create_comment",
      "rio__get_contact",
      "rio__update_contact",
    ],
  );
  const schema = request.tools!.find(
    (tool) => tool.function.name === "rio__get_contact",
  )!.function.parameters;
  expect(Object.keys(schema.properties ?? {})).toEqual([]);
  expect(rio.calls).toEqual([
    {
      name: "get_contact",
      args: { identifier: "id:61" },
      authorization: "Bearer rio-mcp-token",
    },
  ]);
  f.telegram.customerMessage(1, { text: "Hi" });
  await waitFor(() => f.telegram.sentTexts(1).length === 1);
  expect(
    toolNames(mainRequests(f.gateway).at(-1)!).some((name) =>
      name.startsWith("rio__"),
    ),
  ).toBe(false);
});

async function attempt(
  toolCall: { name: string; args: Record<string, unknown> },
  extra: Record<string, string> = {},
) {
  f.gateway.reply(afterTools({ toolCalls: [toolCall] }, { text: "Done" }));
  const app = await f.start(rioEnv(extra));
  await deliver(app.url, incoming("62", { type: "text", text: "Please" }));
  await waitFor(() => f.respond.sentTexts("62").length === 1);
  return toolResults(mainRequests(f.gateway)[1]!).join();
}

test("§9 labels outside the permitted set are rejected without being applied", async () => {
  const result = await attempt({
    name: "rio__add_contact_tags",
    args: { tags: ["vip"] },
  });
  expect(result).toContain(
    "The labels vip are not permitted. The action was not applied.",
  );
  expect(rio.calls).toHaveLength(0);
});

test("§9 permitted labels and name edits are applied to the current contact", async () => {
  await attempt({ name: "rio__update_contact", args: { firstName: "Maria" } });
  expect(rio.calls.map((call) => call.args)).toEqual([
    { identifier: "id:62", firstName: "Maria" },
  ]);
});

test("§9 phone, email and custom-field edits stay disabled until enabled", async () => {
  expect(
    await attempt({ name: "rio__update_contact", args: { email: "a@b.c" } }),
  ).toContain("Editing email is not permitted.");
  expect(rio.calls).toHaveLength(0);
});

test("§9 status changes are disabled until explicitly enabled with permitted changes", async () => {
  const tools = "get_contact,update_conversation_status";
  expect(
    await attempt(
      { name: "rio__update_conversation_status", args: { status: "close" } },
      { CONNECTION_RIO_MCP_TOOLS: tools },
    ),
  ).toContain('The status change "close" is not permitted.');
  expect(rio.calls).toHaveLength(0);
});

test("§9 tools that cannot be limited to the current contact, and reply sending, are refused", async () => {
  for (const tool of ["list_contacts", "send_message"]) {
    const env = {
      ...f.env(),
      ...rioEnv({ CONNECTION_RIO_MCP_TOOLS: `get_contact,${tool}` }),
      DATA_DIR: await tempDir(),
    };
    const { child } = launch(env);
    expect(await child.exited).toBe(1);
  }
});
