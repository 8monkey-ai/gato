import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { skillCatalogue } from "./catalogue.ts";
import { InstructionsError, loadRevision } from "./loader.ts";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "gato-skills-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(files: Record<string, string | Uint8Array>) {
  for (const [file, content] of Object.entries(files))
    await Bun.write(path.join(root, file), content);
}

function skill(name: string, description: string, body = "Body.") {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

test("filters the instructions and the skills for the country", async () => {
  await write({
    "AGENTS.md": "Be kind.\n:::my\nUse ringgit.\n:::\n:::ph\nUse pesos.\n:::\n",
    "skills/refunds/SKILL.md": skill(
      "refunds",
      "Refund rules my[for Malaysia]ph[for the Philippines].",
    ),
    "skills/refunds/references/policy.md": "Limit: my[RM 100]ph[PHP 1000].",
  });
  const revision = await loadRevision(root, "PH");
  expect(revision.instructions).toBe("Be kind.\nUse pesos.\n");
  expect(revision.skills).toEqual([
    {
      name: "refunds",
      description: "Refund rules for the Philippines.",
      dir: path.join(root, "skills", "refunds"),
    },
  ]);
  expect(revision.problems).toEqual([]);
  expect(revision.read("refunds/references/policy.md")).toEqual({
    ok: true,
    text: "Limit: PHP 1000.",
  });
  expect(skillCatalogue(revision)).toBe(
    "- refunds: Refund rules for the Philippines.",
  );
});

test("reports a duplicate skill name and keeps the first skill", async () => {
  await write({
    "AGENTS.md": "Rules.",
    "skills/alpha/SKILL.md": skill("alpha", "First."),
    "skills/beta/SKILL.md": skill("alpha", "Second."),
  });
  const revision = await loadRevision(root, "MY");
  expect(revision.skills.map((s) => [s.name, s.description])).toEqual([
    ["alpha", "First."],
  ]);
  expect(revision.problems).toEqual([
    'skills/beta: name "alpha" does not match the directory name',
    'skills/beta: name "alpha" is already in use, skill not loaded',
  ]);
});

test("hides a skill with an empty description for the country", async () => {
  await write({
    "AGENTS.md": "Rules.",
    "skills/ph-only/SKILL.md": skill("ph-only", "ph[Philippine promotions]"),
  });
  const revision = await loadRevision(root, "MY");
  expect(revision.skills).toEqual([]);
  expect(revision.problems).toEqual([]);
  expect(revision.read("ph-only/SKILL.md")).toEqual({
    ok: false,
    error: '"ph-only/SKILL.md" is not a file of a loaded skill',
  });
});

test("reports invalid skills and excludes them", async () => {
  await write({
    "AGENTS.md": "Rules.",
    "skills/empty/notes.md": "No skill file.",
    "skills/no-name/SKILL.md": "---\ndescription: Something.\n---\n",
    "skills/broken/SKILL.md": "---\nname: [broken\n---\n",
    "skills/markup/SKILL.md": skill("markup", "Fine.", ":::my\nunclosed"),
    "skills/Upper/SKILL.md": skill("Upper", "Fine."),
  });
  const revision = await loadRevision(root, "MY");
  expect(revision.skills).toEqual([]);
  expect(
    revision.problems.map((p) =>
      p.replace(/: invalid frontmatter: .*/, ": invalid frontmatter"),
    ),
  ).toEqual([
    'skills/Upper/SKILL.md: name "Upper" must be 1-64 lowercase letters, digits, and single hyphens, skill not loaded',
    "skills/broken/SKILL.md: invalid frontmatter",
    "skills/empty: SKILL.md is missing, skill not loaded",
    "skills/markup/SKILL.md: line 5: country block is not closed, skill not loaded",
    "skills/no-name/SKILL.md: name is missing, skill not loaded",
  ]);
});

test("reports malformed markup in a reference and refuses to read it", async () => {
  await write({
    "AGENTS.md": "Rules.",
    "skills/faq/SKILL.md": skill("faq", "Questions."),
    "skills/faq/references/bad.md": "a\nmy[b",
  });
  const revision = await loadRevision(root, "MY");
  expect(revision.skills.map((s) => s.name)).toEqual(["faq"]);
  expect(revision.problems).toEqual([
    'skills/faq/references/bad.md: line 2: "my[" is not closed',
  ]);
  expect(revision.read("faq/references/bad.md")).toEqual({
    ok: false,
    error: 'line 2: "my[" is not closed',
  });
});

test("reads every file at load time", async () => {
  await write({
    "AGENTS.md": "Rules.",
    "skills/faq/SKILL.md": skill("faq", "Questions.", "Old."),
  });
  const revision = await loadRevision(root, "MY");
  await write({ "skills/faq/SKILL.md": skill("faq", "Questions.", "New.") });
  expect(revision.read("faq/SKILL.md")).toEqual({
    ok: true,
    text: "---\nname: faq\ndescription: Questions.\n---\nOld.\n",
  });
});

test("changes the revision id when a file changes", async () => {
  await write({
    "AGENTS.md": "Rules.",
    "skills/faq/references/a.md": "One.",
  });
  await write({ "skills/faq/SKILL.md": skill("faq", "Questions.") });
  const first = await loadRevision(root, "MY");
  const same = await loadRevision(root, "MY");
  await write({ "skills/faq/references/a.md": "Two." });
  const changed = await loadRevision(root, "MY");
  expect(first.id).toMatch(/^[0-9a-f]{12}$/);
  expect(same.id).toBe(first.id);
  expect(changed.id).not.toBe(first.id);
});

test("rejects paths outside the loaded skill files", async () => {
  await write({
    "AGENTS.md": "Rules.",
    "secret.txt": "Secret.",
    "skills/faq/SKILL.md": skill("faq", "Questions."),
  });
  await symlink(
    path.join(root, "secret.txt"),
    path.join(root, "skills/faq/link.md"),
  );
  await write({
    "skills/faq/image.png": new Uint8Array([0x89, 0x50, 0x00, 0xff]),
  });
  const revision = await loadRevision(root, "MY");
  expect(revision.read("faq/../../secret.txt")).toEqual({
    ok: false,
    error: '"faq/../../secret.txt" must not contain ".."',
  });
  expect(revision.read(path.join(root, "secret.txt"))).toEqual({
    ok: false,
    error: `"${path.join(root, "secret.txt")}" is absolute; use a path such as <skill>/SKILL.md`,
  });
  for (const file of ["faq/link.md", "faq/image.png", "AGENTS.md"]) {
    expect(revision.read(file)).toEqual({
      ok: false,
      error: `"${file}" is not a file of a loaded skill`,
    });
  }
});

test("reports an oversized file", async () => {
  await write({
    "AGENTS.md": "Rules.",
    "skills/faq/SKILL.md": skill("faq", "Questions."),
    "skills/faq/big.md": "x".repeat(256 * 1024 + 1),
  });
  const revision = await loadRevision(root, "MY");
  expect(revision.problems).toEqual([
    "skills/faq/big.md: larger than 256 KiB, not loaded",
  ]);
});

test("fails without AGENTS.md", async () => {
  const error = await loadRevision(root, "MY").catch(
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(InstructionsError);
  expect((error as Error).message).toBe(`AGENTS.md is missing in ${root}`);
});

test("fails when AGENTS.md is empty for the country", async () => {
  await write({ "AGENTS.md": ":::ph\nPhilippines only.\n:::\n" });
  await expect(loadRevision(root, "MY")).rejects.toThrow(
    "AGENTS.md contains no instructions for MY",
  );
});

test("fails on malformed markup in AGENTS.md", async () => {
  await write({ "AGENTS.md": "Rules.\n:::\n" });
  await expect(loadRevision(root, "MY")).rejects.toThrow(
    'AGENTS.md: line 2: ":::" closes no country block',
  );
});
