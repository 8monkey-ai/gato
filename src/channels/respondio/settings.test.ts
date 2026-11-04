import { expect, test } from "bun:test";

import { createEnvReader } from "../../config/env.ts";
import { readRespondioSettings } from "./settings.ts";

const scope = "GATO_CONNECTION_RIO_";

function read(vars: Record<string, string>) {
  const env = createEnvReader(vars);
  const settings = readRespondioSettings(env.scope(scope));
  return { settings, assertValid: () => env.assertValid() };
}

const required = {
  [`${scope}API_TOKEN`]: "tok",
  [`${scope}SIGNING_KEYS`]: "a, b",
  [`${scope}AGENT_USER_ID`]: "99",
};

test("applies defaults and takes MCP labels from the core label settings", () => {
  const { settings, assertValid } = read({
    ...required,
    GATO_LABEL_HANDOFF: "human",
    [`${scope}MCP_ENABLED`]: "true",
    [`${scope}MCP_TOKEN`]: "mcp",
    [`${scope}MCP_EXTRA_LABELS`]: "vip",
  });
  assertValid();
  expect(settings).toEqual({
    apiToken: "tok",
    signingKeys: ["a", "b"],
    agentUserId: "99",
    channelId: undefined,
    apiUrl: "https://api.respond.io/v2",
    maxTextLength: 4096,
    mcp: {
      url: "https://mcp.respond.io/mcp",
      token: "mcp",
      tools: [
        "get_contact",
        "create_comment",
        "add_contact_tags",
        "update_contact",
      ],
      editableFields: ["firstName", "lastName", "language"],
      labels: ["human", "out-of-scope", "vip"],
      statusChanges: [],
    },
  });
});

test("names every missing or invalid setting", () => {
  const { assertValid } = read({
    [`${scope}SIGNING_KEYS`]: ",",
    [`${scope}CHANNEL_ID`]: "x",
    [`${scope}MCP_ENABLED`]: "true",
    [`${scope}MCP_STATUS_CHANGES`]: "closed",
  });
  expect(assertValid).toThrow(
    [
      "Invalid configuration:",
      `  - ${scope}API_TOKEN: required; accepted: any text`,
      `  - ${scope}SIGNING_KEYS: "," is not valid; accepted: a comma separated list of webhook signing keys`,
      `  - ${scope}AGENT_USER_ID: required; accepted: a positive integer`,
      `  - ${scope}CHANNEL_ID: "x" is not valid; accepted: a positive integer`,
      `  - ${scope}MCP_TOKEN: required; accepted: any text`,
      `  - ${scope}MCP_STATUS_CHANGES: "closed" is not valid; accepted: a comma separated list of open, close`,
    ].join("\n"),
  );
});
