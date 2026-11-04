import { expect, test } from "bun:test";

import { readSkillTool } from "./read-tool.ts";

const files: Record<string, string> = { "faq/SKILL.md": "Answer questions." };

const tool = readSkillTool({
  read: (path) =>
    path in files
      ? { ok: true, text: files[path] ?? "" }
      : { ok: false, error: `no file "${path}"` },
});

test("returns the text of a skill file", async () => {
  expect(tool.name).toBe("read_skill");
  expect(
    await tool.execute({ path: "faq/SKILL.md" }, AbortSignal.timeout(1000)),
  ).toEqual({
    output: "Answer questions.",
    isError: false,
  });
});

test("returns the read error as a tool error", async () => {
  expect(
    await tool.execute({ path: "faq/x.md" }, AbortSignal.timeout(1000)),
  ).toEqual({
    output: 'no file "faq/x.md"',
    isError: true,
  });
});

test("rejects input without a path", async () => {
  expect(
    await tool.execute({ file: "faq/SKILL.md" }, AbortSignal.timeout(1000)),
  ).toEqual({
    output: 'Input must be { "path": string }.',
    isError: true,
  });
});

test("declares a path string as input", () => {
  expect(tool.inputSchema).toMatchObject({
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  });
});
