import { expect, test } from "bun:test";

import type { AgentTool } from "./tool.ts";
import { assertUniqueToolNames } from "./toolset.ts";

const tool = (name: string): AgentTool => ({
  name,
  description: "",
  inputSchema: { type: "object" },
  execute: () => Promise.resolve({ isError: false, output: null }),
});

test("accepts distinct tool names", () => {
  expect(() =>
    assertUniqueToolNames([tool("read_skill"), tool("shop_lookup")]),
  ).not.toThrow();
});

test("lists each duplicate tool name once", () => {
  expect(() =>
    assertUniqueToolNames(
      [
        "shop_lookup",
        "read_skill",
        "shop_lookup",
        "shop_lookup",
        "crm_a",
        "crm_a",
      ].map(tool),
    ),
  ).toThrow("Duplicate tool names: shop_lookup, crm_a");
});
