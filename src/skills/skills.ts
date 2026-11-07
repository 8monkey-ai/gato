import { dirname, join } from "node:path";

import { type Country, filterCountry } from "./country.ts";

type Skill = {
  description: string;
  body: string;
  files: Map<string, string | Error>;
};

export type Instructions = {
  business: string;
  skills: Map<string, Skill>;
  problems: string[];
};

export class InstructionsError extends Error {}

const skillName = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/;
const referenceFiles = new Bun.Glob("**/*.{md,txt,json,csv,yaml,yml}");

export async function loadInstructions(
  dir: string,
  country: Country,
): Promise<Instructions> {
  const agents = Bun.file(join(dir, "AGENTS.md"));
  if (!(await agents.exists()))
    throw new InstructionsError(`${join(dir, "AGENTS.md")} is missing`);
  let business: string;
  try {
    business = filterCountry(await agents.text(), country).trim();
  } catch (error) {
    throw new InstructionsError(`AGENTS.md: ${(error as Error).message}`);
  }
  const problems: string[] = [];
  const found = new Map<string, Skill>();
  const duplicates = new Set<string>();
  for await (const path of new Bun.Glob("**/SKILL.md").scan({
    cwd: dir,
    dot: true,
  })) {
    if (path.startsWith(".git/")) continue;
    const skill = await loadSkill(dir, path, country).catch((error: Error) => {
      problems.push(`${path}: ${error.message}`);
    });
    if (!skill) continue;
    if (found.has(skill.name)) duplicates.add(skill.name);
    found.set(skill.name, skill.skill);
  }
  for (const name of duplicates) {
    problems.push(`Skill "${name}" exists more than once and is not used`);
    found.delete(name);
  }
  const skills = new Map([...found].filter(([, skill]) => skill.description));
  return { business, skills, problems };
}

async function loadSkill(root: string, path: string, country: Country) {
  const folder = dirname(path);
  const { name, description, body } = parseSkillFile(
    await Bun.file(join(root, path)).text(),
  );
  if (!skillName.test(name) || name !== folder.split("/").pop()) {
    throw new Error(
      `The name "${name}" is not valid or does not match its folder`,
    );
  }
  const skill: Skill = {
    description: filterCountry(description, country).trim(),
    body: filterCountry(body, country).trim(),
    files: new Map(),
  };
  for await (const file of referenceFiles.scan({ cwd: join(root, folder) })) {
    if (file === "SKILL.md" || file.startsWith("scripts/")) continue;
    const text = await Bun.file(join(root, folder, file)).text();
    skill.files.set(
      file,
      attempt(() => filterCountry(text, country)),
    );
  }
  return { name, skill };
}

function parseSkillFile(content: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) throw new Error("SKILL.md has no YAML frontmatter");
  const meta = Bun.YAML.parse(match[1] ?? "") as {
    name?: unknown;
    description?: unknown;
  } | null;
  const description = meta?.description;
  if (typeof description !== "string" || !description.trim())
    throw new Error("The description is missing");
  return {
    name: typeof meta?.name === "string" ? meta.name : "",
    description,
    body: match[2] ?? "",
  };
}

function attempt(work: () => string): string | Error {
  try {
    return work();
  } catch (error) {
    return error as Error;
  }
}

export function readSkill(
  instructions: Instructions,
  name: string,
  file?: string,
): string {
  const skill = instructions.skills.get(name);
  if (!skill) throw new Error(`There is no skill "${name}"`);
  if (!file || file === "SKILL.md") return skill.body;
  const content = skill.files.get(file.replace(/^\.\//, ""));
  if (content === undefined)
    throw new Error(`Skill "${name}" has no file "${file}"`);
  if (content instanceof Error)
    throw new Error(`File "${file}" cannot be used: ${content.message}`);
  return content;
}

export function skillCatalogue(instructions: Instructions): string {
  const lines = [...instructions.skills]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, skill]) => `- ${name}: ${skill.description}`);
  return lines.join("\n") || "(none)";
}
