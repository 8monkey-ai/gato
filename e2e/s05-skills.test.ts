import { expect, test } from "bun:test";

import { launch, tempDir, waitFor } from "./support/app.ts";
import { useTelegram } from "./support/fixture.ts";
import { afterTools, systemText, toolResults } from "./support/gateway.ts";
import { readChat } from "./support/setup.ts";
import { commitFiles, createSkillsRepo } from "./support/skills.ts";

const f = useTelegram();

const countrySkills = {
  "AGENTS.md":
    "Common rules.\n:::my\nMalaysia rules.\n:::\n:::ph\nPhilippines rules.\n:::\nHotline: my[1300-MY]ph[1800-PH].",
  "skills/refunds/SKILL.md":
    "---\nname: refunds\ndescription: Refunds my[in Malaysia]ph[in the Philippines].\n---\nWait my[5]ph[7] days.",
  "skills/ph-promo/SKILL.md":
    "---\nname: ph-promo\ndescription: ph[Philippine promotions.]\n---\nPromo.",
  "README.md": "Not approved material.",
};

test("§5 repository instructions and the skill catalogue reach the agent, and the agent reads a skill with the built-in tool", async () => {
  f.gateway.reply(
    afterTools(
      { toolCalls: [{ name: "read_skill", args: { path: "skills/refunds" } }] },
      { text: "5 days" },
    ),
  );
  await f.start();
  f.telegram.customerMessage(1, { text: "Refund?" });
  await waitFor(() => f.telegram.sentTexts(1).length === 1);
  const system = systemText(f.gateway.requests[0]!);
  expect(system).toContain("You are the customer service agent of Example Co.");
  expect(system).toContain(
    "- refunds (skills/refunds): How to handle refund requests.",
  );
  expect(toolResults(f.gateway.requests[1]!).join()).toContain(
    "Refunds take 5 days.",
  );
  expect(f.telegram.sentTexts(1)).toEqual(["5 days"]);
});

test("§5 the selected country filters instructions, skill descriptions and bodies, and removes all markers", async () => {
  await commitFiles(f.skillsDir, countrySkills);
  f.gateway.reply(
    afterTools(
      {
        toolCalls: [
          { name: "read_skill", args: { path: "skills/refunds/SKILL.md" } },
        ],
      },
      { text: "Ok" },
    ),
  );
  await f.start({ COUNTRY: "PH" });
  f.telegram.customerMessage(1, { text: "Hi" });
  await waitFor(() => f.telegram.sentTexts(1).length === 1);
  const system = systemText(f.gateway.requests[0]!);
  expect(system).toContain(
    "Common rules.\nPhilippines rules.\nHotline: 1800-PH.",
  );
  expect(system).not.toContain("Malaysia");
  expect(system).not.toMatch(/:::|my\[|ph\[/);
  expect(system).toContain(
    "- ph-promo (skills/ph-promo): Philippine promotions.",
  );
  expect(toolResults(f.gateway.requests[1]!).join()).toContain("Wait 7 days.");
});

test("§5 a skill whose filtered description is empty is hidden", async () => {
  await commitFiles(f.skillsDir, countrySkills);
  f.gateway.reply({ text: "Ok" });
  await f.start({ COUNTRY: "MY" });
  f.telegram.customerMessage(1, { text: "Hi" });
  await waitFor(() => f.telegram.sentTexts(1).length === 1);
  const system = systemText(f.gateway.requests[0]!);
  expect(system).toContain("- refunds (skills/refunds): Refunds in Malaysia.");
  expect(system).not.toContain("ph-promo");
});

test("§5 reading is restricted to approved skill material", async () => {
  await commitFiles(f.skillsDir, countrySkills);
  let calls = 0;
  f.gateway.reply(() => {
    calls++;
    if (calls === 1)
      return {
        toolCalls: [{ name: "read_skill", args: { path: "README.md" } }],
      };
    if (calls === 2)
      return {
        toolCalls: [{ name: "read_skill", args: { path: "../../etc/passwd" } }],
      };
    return { text: "Done" };
  });
  await f.start();
  f.telegram.customerMessage(1, { text: "Hi" });
  await waitFor(() => f.telegram.sentTexts(1).length === 1);
  const results = toolResults(f.gateway.requests[2]!).join("\n");
  expect(results).toContain('"README.md" is not an approved skill file.');
  expect(results).toContain(
    '"../../etc/passwd" is not an approved skill file.',
  );
  expect(results).not.toContain("Not approved material.");
});

test("§5 each turn keeps the instruction revision it started with; new turns use the update", async () => {
  let calls = 0;
  f.gateway.reply(async () => {
    calls++;
    if (calls === 1) {
      const updated =
        "---\nname: refunds\ndescription: New.\n---\nRefunds take 9 days.";
      await commitFiles(f.skillsDir, {
        "AGENTS.md": "Updated rules.",
        "skills/refunds/SKILL.md": updated,
      });
      return {
        toolCalls: [{ name: "read_skill", args: { path: "skills/refunds" } }],
      };
    }
    return { text: `Answer ${calls}` };
  });
  await f.start();
  f.telegram.customerMessage(1, { text: "Refund?" });
  await waitFor(() => f.telegram.sentTexts(1).length === 1);
  expect(toolResults(f.gateway.requests[1]!).join()).toContain(
    "Refunds take 5 days.",
  );
  f.telegram.customerMessage(1, { text: "Again?" });
  await waitFor(() => f.telegram.sentTexts(1).length === 2);
  expect(systemText(f.gateway.requests[2]!)).toContain("Updated rules.");
});

test("§5 missing, invalid and duplicate skills are reported", async () => {
  await commitFiles(f.skillsDir, {
    "skills/broken/SKILL.md": "no frontmatter",
    "skills/wrong/SKILL.md": "---\nname: other\ndescription: x\n---\n",
    "a/dup/SKILL.md": "---\nname: dup\ndescription: one\n---\n",
    "b/dup/SKILL.md": "---\nname: dup\ndescription: two\n---\n",
    "skills/bad-markup/SKILL.md":
      "---\nname: bad-markup\ndescription: x\n---\n:::my\nunclosed",
  });
  const app = await f.start();
  const health = (await (await fetch(`${app.url}/health`)).json()) as {
    skillProblems: string[];
  };
  expect(health.skillProblems.toSorted()).toEqual([
    'Duplicate skill "dup" in a/dup, b/dup.',
    'skills/bad-markup: Country block "my" has no end.',
    "skills/broken: SKILL.md has no frontmatter.",
    'skills/wrong: the name "other" does not match the folder.',
  ]);
});

test("§5 missing required instructions prevent startup", async () => {
  const skillsDir = await createSkillsRepo({
    "skills/refunds/SKILL.md": "---\nname: refunds\ndescription: x\n---\n",
  });
  const { child, logs } = launch({
    ...f.env(),
    SKILLS_DIR: skillsDir,
    DATA_DIR: await tempDir(),
  });
  expect(await child.exited).toBe(1);
  await Bun.sleep(50);
  expect(logs.join("\n")).toContain("The skills repository has no AGENTS.md.");
});

test("§5 instructions that become unusable cause a visible failure instead of an answer without them", async () => {
  f.gateway.reply({ text: "Should not be sent" });
  await f.start();
  await commitFiles(f.skillsDir, { "AGENTS.md": ":::my\nunclosed" });
  f.telegram.customerMessage(1, { text: "Hi" });
  const entries = await waitFor(async () => {
    const chat = await readChat(f.app.dataDir, "tg", "1");
    return chat.some((entry) => entry.type === "error") && chat;
  });
  expect(f.gateway.requests).toHaveLength(0);
  expect(f.telegram.sentTexts(1)).toHaveLength(0);
  expect(entries.find((entry) => entry.type === "error")?.text).toContain(
    'AGENTS.md: Country block "my" has no end.',
  );
});
