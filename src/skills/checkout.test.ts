import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { SkillsCheckout } from "./checkout.ts";

async function checkout(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "skills-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const problems: string[] = [];
  return {
    skills: new SkillsCheckout(root, "my", (found) => problems.push(...found)),
    problems,
    root,
  };
}

const skill = (name: string, description = "Helps.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`;

test("loads instructions and valid skills, and reads only approved material", async () => {
  const { skills } = await checkout({
    "AGENTS.md": "Be kind.",
    "skills/refunds/SKILL.md": skill("refunds"),
    "skills/refunds/references/policy.md": "my[Policy MY]",
    "other/notes.md": "private",
  });
  const revision = await skills.current();
  expect(revision.instructions).toBe("Be kind.");
  expect(revision.skills).toEqual([
    { name: "refunds", description: "Helps.", path: "skills/refunds/SKILL.md" },
  ]);
  expect(revision.read("./skills/refunds/references/policy.md")).toBe(
    "Policy MY",
  );
  expect(() => revision.read("other/notes.md")).toThrow("not approved");
  expect(() => revision.read("skills/refunds/../../other/notes.md")).toThrow(
    "not approved",
  );
});

test("reports a missing name match, and requires repository instructions", async () => {
  const { skills, problems } = await checkout({
    "AGENTS.md": "x",
    "skills/a/SKILL.md": skill("b"),
  });
  expect((await skills.current()).skills).toEqual([]);
  expect(problems).toEqual([
    'skills/a/SKILL.md: name "b" differs from its folder "a"',
  ]);
  const empty = await checkout({ "skills/a/SKILL.md": skill("a") });
  await expect(empty.skills.current()).rejects.toThrow("no AGENTS.md");
});

test("a taken revision stays the same after the files change", async () => {
  const { skills, root } = await checkout({
    "AGENTS.md": "x",
    "skills/a/SKILL.md": skill("a"),
  });
  const before = await skills.current();
  await writeFile(
    join(root, "skills/a/SKILL.md"),
    skill("a", "Changed description."),
  );
  expect(before.read("skills/a/SKILL.md")).toContain("Helps.");
  expect((await skills.current()).skills[0]?.description).toBe(
    "Changed description.",
  );
});
