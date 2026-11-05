import { posix } from "node:path";

import { YAML } from "bun";

import type { Country } from "../config/settings.ts";
import { log } from "../log.ts";
import { CountryMarkupError, filterCountry } from "./country.ts";
import { headRevision, listFiles, readAt } from "./git.ts";

export interface Skill {
  name: string;
  description: string;
  path: string;
}

export interface Snapshot {
  revision: string;
  instructions: string;
  skills: Skill[];
  read(path: string): Promise<string>;
}

const skillName = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function frontmatterOf(dir: string, text: string) {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (block === undefined) return `${dir}: SKILL.md has no frontmatter.`;
  const data = YAML.parse(block) as {
    name?: unknown;
    description?: unknown;
  } | null;
  const { name, description } = data ?? {};
  if (typeof name !== "string" || !skillName.test(name) || name.length > 64) {
    return `${dir}: invalid name.`;
  }
  if (name !== posix.basename(dir)) {
    return `${dir}: the name "${name}" does not match the folder.`;
  }
  if (typeof description !== "string" || description.trim() === "") {
    return `${dir}: missing description.`;
  }
  return { name, description };
}

function parseSkill(
  dir: string,
  text: string,
  country: Country,
): Skill | string | undefined {
  const data = frontmatterOf(dir, text);
  if (typeof data === "string") return data;
  try {
    filterCountry(text, country);
    const description = filterCountry(data.description, country).trim();
    return description === ""
      ? undefined
      : { name: data.name, description, path: dir };
  } catch (error) {
    return `${dir}: ${(error as Error).message}`;
  }
}

function withoutDuplicates(skills: Skill[], problems: string[]) {
  const counts = Map.groupBy(skills, (skill) => skill.name);
  for (const [name, group] of counts) {
    if (group.length > 1)
      problems.push(
        `Duplicate skill "${name}" in ${group.map((skill) => skill.path).join(", ")}.`,
      );
  }
  return skills.filter((skill) => counts.get(skill.name)!.length === 1);
}

async function readInstructions(
  dir: string,
  revision: string,
  files: string[],
  country: Country,
) {
  if (!files.includes("AGENTS.md"))
    throw new Error("The skills repository has no AGENTS.md.");
  try {
    return filterCountry(await readAt(dir, revision, "AGENTS.md"), country);
  } catch (error) {
    if (error instanceof CountryMarkupError) {
      throw new Error(`AGENTS.md: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

async function readSkills(
  dir: string,
  revision: string,
  files: string[],
  country: Country,
) {
  const problems: string[] = [];
  const skills: Skill[] = [];
  for (const file of files.filter((path) => path.endsWith("/SKILL.md"))) {
    const parsed = parseSkill(
      posix.dirname(file),
      await readAt(dir, revision, file),
      country,
    );
    if (typeof parsed === "string") problems.push(parsed);
    else if (parsed) skills.push(parsed);
  }
  return { skills: withoutDuplicates(skills, problems), problems };
}

function reader(
  dir: string,
  revision: string,
  files: string[],
  skills: Skill[],
  country: Country,
) {
  const approved = (path: string) =>
    skills.some((skill) => path.startsWith(`${skill.path}/`)) &&
    files.includes(path);
  return async (requested: string) => {
    const normal = posix.normalize(requested.trim()).replace(/\/$/, "");
    const path = skills.some((skill) => skill.path === normal)
      ? `${normal}/SKILL.md`
      : normal;
    if (path.startsWith("/") || path.startsWith("..") || !approved(path)) {
      throw new Error(`"${requested}" is not an approved skill file.`);
    }
    const text = await readAt(dir, revision, path);
    if (text.includes("\0"))
      throw new Error(`"${requested}" is not a text file.`);
    return filterCountry(text, country);
  };
}

type LoadedSnapshot = Snapshot & { problems: string[] };

async function loadSnapshot(
  dir: string,
  revision: string,
  country: Country,
): Promise<LoadedSnapshot> {
  const files = await listFiles(dir, revision);
  const instructions = await readInstructions(dir, revision, files, country);
  const { skills, problems } = await readSkills(dir, revision, files, country);
  for (const problem of problems)
    log("warn", "skills.problem", { revision, problem });
  const read = reader(dir, revision, files, skills, country);
  return { revision, instructions, skills, read, problems };
}

export function createSkills(dir: string, country: Country) {
  let cached:
    { revision: string; snapshot: Promise<LoadedSnapshot> } | undefined;
  return {
    async current(): Promise<Snapshot> {
      const revision = await headRevision(dir);
      if (cached?.revision !== revision) {
        cached = { revision, snapshot: loadSnapshot(dir, revision, country) };
      }
      return await cached.snapshot;
    },
    async problems() {
      return cached ? (await cached.snapshot).problems : [];
    },
  };
}

export type Skills = ReturnType<typeof createSkills>;
