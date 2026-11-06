import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultSkills, readChat, startApp } from "./support/app.ts";
import type { ChatRequest } from "./support/fake-gateway.ts";
import { until } from "./support/recorder.ts";
import { startHarness } from "./support/setup.ts";

const system = (request: ChatRequest | undefined) =>
  JSON.stringify(request?.messages[0]);
const toolResults = (request: ChatRequest | undefined) =>
  JSON.stringify(request?.messages.filter((m) => m.role === "tool"));

const readPricing = (path = "skills/pricing/SKILL.md") => ({
  toolCalls: [{ name: "read_skill", args: { path } }],
});

test("§5 country: Malaysia content is kept and Philippines content and markers are removed", async () => {
  const { telegram, gateway } = await startHarness();
  gateway.script((_, index) =>
    index === 0 ? readPricing() : { text: "Done." },
  );
  telegram.push(80, { text: "price?" });
  await until(() => telegram.sent().length === 1);

  const prompt = system(gateway.requests[0]);
  expect(prompt).toContain("Malaysia rule.");
  expect(prompt).toContain("Prices in MYR.");
  expect(prompt).not.toContain("Philippines rule");
  expect(prompt).not.toContain(":::");
  expect(toolResults(gateway.requests[1])).toContain("Price list. RM 10");
  expect(toolResults(gateway.requests[1])).not.toContain("PHP 100");
});

test("§5 country: the Philippines selection applies to instructions and skill reads", async () => {
  const { telegram, gateway } = await startHarness({ env: { COUNTRY: "PH" } });
  gateway.script((_, index) =>
    index === 0 ? readPricing() : { text: "Done." },
  );
  telegram.push(81, { text: "price?" });
  await until(() => telegram.sent().length === 1);

  expect(system(gateway.requests[0])).toContain("Philippines rule.");
  expect(system(gateway.requests[0])).not.toContain("Malaysia rule");
  expect(toolResults(gateway.requests[1])).toContain("Price list. PHP 100");
});

test("§5 country: a missing or unsupported country prevents startup", async () => {
  const { env } = await startHarness();
  for (const country of ["", "SG"]) {
    const app = await startApp(
      { ...env, COUNTRY: country },
      { waitReady: false },
    );
    expect(await app.exited).toBe(1);
    expect(app.logs.join("\n")).toContain("COUNTRY");
  }
});

test("§5 skills: reading gives access only to approved skill material", async () => {
  const skills = { ...defaultSkills, "notes/private.md": "secret notes" };
  const { telegram, gateway } = await startHarness({ skills });
  gateway.script((_, index) =>
    index === 0 ? readPricing("notes/private.md") : { text: "Done." },
  );
  telegram.push(82, { text: "hi" });
  await until(() => telegram.sent().length === 1);

  const result = toolResults(gateway.requests[1]);
  expect(result).toContain("is not approved skill material");
  expect(result).not.toContain("secret notes");
});

test("§5 skills: invalid and duplicate skills are reported, and a skill with an empty filtered description is hidden", async () => {
  const skills = {
    ...defaultSkills,
    "skills/broken/SKILL.md": "no front matter",
    "a/twin/SKILL.md": "---\nname: twin\ndescription: one\n---\n",
    "b/twin/SKILL.md": "---\nname: twin\ndescription: two\n---\n",
    "skills/ph-only/SKILL.md":
      "---\nname: ph-only\ndescription: ph[Only for PH]\n---\n",
  };
  const { app, telegram, gateway } = await startHarness({ skills });
  telegram.push(83, { text: "hi" });
  await until(() => telegram.sent().length === 1);

  const problems = app.logs
    .filter((l) => l.includes("skills.problem"))
    .join("\n");
  expect(problems).toContain("skills/broken/SKILL.md: missing front matter");
  expect(problems).toContain('duplicate skill \\"twin\\"');
  const prompt = system(gateway.requests[0]);
  expect(prompt).toContain("- pricing:");
  expect(prompt).not.toContain("twin");
  expect(prompt).not.toContain("ph-only");
});

test("§5 instructions: malformed required instructions cause a visible failure, not an answer without them", async () => {
  const { telegram, gateway, skillsDir, dataDir } = await startHarness();
  writeFileSync(
    join(skillsDir, "AGENTS.md"),
    ":::my\nunclosed block and more text\n",
  );
  telegram.push(84, { text: "hi" });

  const record = await until(async () => {
    const entries = await readChat(dataDir, "telegram", "84");
    return entries.some((e) => e.meta.kind === "error") && entries;
  });
  expect(record.find((e) => e.meta.kind === "error")?.text).toContain(
    "unclosed :::my block",
  );
  expect(gateway.requests).toHaveLength(0);
  expect(telegram.sent()).toHaveLength(0);
});

test("§5 revisions: a turn keeps the revision it started with, and the next turn uses the update", async () => {
  const { telegram, gateway, skillsDir } = await startHarness();
  const skillFile = join(skillsDir, "skills/pricing/SKILL.md");
  gateway.script((_, index) => {
    if (index === 0) {
      writeFileSync(
        skillFile,
        "---\nname: pricing\ndescription: New prices.\n---\nUpdated price list: RM 99\n",
      );
      return readPricing();
    }
    return index === 2 ? readPricing() : { text: "Done." };
  });
  telegram.push(85, { text: "price?" });
  await until(() => telegram.sent().length === 1);
  expect(toolResults(gateway.requests[1])).toContain("RM 10");

  telegram.push(85, { text: "and now?" });
  await until(() => telegram.sent().length === 2);
  expect(system(gateway.requests[2])).toContain("New prices.");
  expect(toolResults(gateway.requests[3])).toContain("RM 99");
});
