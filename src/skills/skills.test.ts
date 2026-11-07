import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InstructionsError,
  loadInstructions,
  readSkill,
  skillCatalogue,
} from "./skills.ts";

async function checkout(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "gato-skills-"));
  for (const [path, text] of Object.entries(files))
    await Bun.write(join(dir, path), text);
  return dir;
}

const skill = (name: string, description: string, body = "Body") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

test("loads country-filtered instructions, skills, and references", async () => {
  const dir = await checkout({
    "AGENTS.md": "Be kind.\n:::ph\nPH rules.\n:::\n",
    "skills/refunds/SKILL.md": skill(
      "refunds",
      "Refunds my[in RM]ph[in PHP]",
      "Steps my[MY]",
    ),
    "skills/refunds/references/prices.md": "Price ph[100 PHP]my[20 RM]",
    "skills/refunds/scripts/run.md": "secret",
    "skills/gcash/SKILL.md": skill("gcash", "ph[GCash payments]"),
    "skills/Bad/SKILL.md": skill("Bad", "x"),
    ".agents/skills/stock/SKILL.md": skill("stock", "Stock checks"),
    ".git/skills/old/SKILL.md": skill("old", "Not a skill"),
    "a/dup/SKILL.md": skill("dup", "one"),
    "b/dup/SKILL.md": skill("dup", "two"),
  });
  const instructions = await loadInstructions(dir, "my");

  expect(instructions.business).toBe("Be kind.");
  expect(skillCatalogue(instructions)).toBe(
    "- refunds: Refunds in RM\n- stock: Stock checks",
  );
  expect(readSkill(instructions, "refunds")).toBe("Steps MY");
  expect(readSkill(instructions, "refunds", "references/prices.md")).toBe(
    "Price 20 RM",
  );
  expect(() => readSkill(instructions, "refunds", "scripts/run.md")).toThrow();
  expect(() => readSkill(instructions, "refunds", "../../AGENTS.md")).toThrow();
  expect(() => readSkill(instructions, "gcash")).toThrow();
  expect(instructions.problems).toHaveLength(2);
});

test("fails without usable repository instructions", async () => {
  await expect(loadInstructions(await checkout({}), "my")).rejects.toThrow(
    InstructionsError,
  );
  const malformed = await checkout({ "AGENTS.md": ":::my\nnot closed" });
  await expect(loadInstructions(malformed, "my")).rejects.toThrow(
    InstructionsError,
  );
});
