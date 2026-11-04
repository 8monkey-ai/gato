import { readdir } from "node:fs/promises";
import path from "node:path";

import { filterCountry, type TextResult } from "./country-filter.ts";
import type { Country } from "./country.ts";
import { readTextFiles } from "./skill-files.ts";
import { parseSkillHeader } from "./skill-header.ts";

export class InstructionsError extends Error {}

type Skill = Readonly<{
  name: string;
  description: string;
  dir: string;
}>;

export type Revision = Readonly<{
  id: string;
  instructions: string;
  skills: readonly Skill[];
  problems: readonly string[];
  read(path: string): TextResult;
}>;

type Hasher = { update(data: string): unknown };

type LoadedSkills = {
  skills: Skill[];
  files: Map<string, TextResult>;
  problems: string[];
};

type BuiltSkill =
  | {
      ok: true;
      name: string;
      description: string;
      files: Map<string, TextResult>;
      problems: string[];
    }
  | { ok: false; problems: string[] };

const validName = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function loadRevision(
  skillsDir: string,
  country: Country,
): Promise<Revision> {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(`${country}\0`);
  const instructions = await loadInstructions(skillsDir, country, hash);
  const { skills, files, problems } = await loadSkills(
    skillsDir,
    country,
    hash,
  );
  return Object.freeze({
    id: hash.digest("hex").slice(0, 12),
    instructions,
    skills: Object.freeze(skills.map((skill) => Object.freeze(skill))),
    problems: Object.freeze(problems),
    read: reader(files),
  });
}

async function loadInstructions(root: string, country: Country, hash: Hasher) {
  const file = Bun.file(path.join(root, "AGENTS.md"));
  if (!(await file.exists()))
    throw new InstructionsError(`AGENTS.md is missing in ${root}`);
  const text = await file.text();
  hash.update(`AGENTS.md\0${text}\0`);
  const filtered = filterCountry(text, country);
  if (!filtered.ok) throw new InstructionsError(`AGENTS.md: ${filtered.error}`);
  if (filtered.text.trim() === "") {
    throw new InstructionsError(
      `AGENTS.md contains no instructions for ${country}`,
    );
  }
  return filtered.text;
}

async function loadSkills(root: string, country: Country, hash: Hasher) {
  const loaded: LoadedSkills = { skills: [], files: new Map(), problems: [] };
  const names = new Set<string>();
  for (const dirName of await skillDirs(root)) {
    const dir = path.join(root, "skills", dirName);
    const { files, oversized } = await readTextFiles(dir);
    for (const [file, text] of files)
      hash.update(`skills/${dirName}/${file}\0${text}\0`);
    for (const file of oversized) {
      loaded.problems.push(
        `skills/${dirName}/${file}: larger than 256 KiB, not loaded`,
      );
    }
    const skill = buildSkill(dirName, files, country);
    loaded.problems.push(...skill.problems);
    if (!skill.ok) continue;
    if (names.has(skill.name)) {
      loaded.problems.push(
        `skills/${dirName}: name "${skill.name}" is already in use, skill not loaded`,
      );
      continue;
    }
    names.add(skill.name);
    if (skill.description === "") continue;
    loaded.skills.push({
      name: skill.name,
      description: skill.description,
      dir,
    });
    for (const [file, text] of skill.files)
      loaded.files.set(`${skill.name}/${file}`, text);
  }
  return loaded;
}

async function skillDirs(root: string) {
  try {
    const entries = await readdir(path.join(root, "skills"), {
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function buildSkill(
  dirName: string,
  files: Map<string, string>,
  country: Country,
): BuiltSkill {
  const where = `skills/${dirName}`;
  const body = files.get("SKILL.md");
  if (body === undefined) return excluded(`${where}: SKILL.md is missing`);
  const header = parseSkillHeader(body);
  if (!header.ok) return excluded(`${where}/SKILL.md: ${header.error}`);
  if (!validName.test(header.name)) {
    return excluded(
      `${where}/SKILL.md: name "${header.name}" must be 1-64 lowercase letters, digits, and single hyphens`,
    );
  }
  const description = filterCountry(header.description, country);
  if (!description.ok)
    return excluded(`${where}/SKILL.md: description: ${description.error}`);
  const filtered = new Map<string, TextResult>();
  for (const [file, text] of files)
    filtered.set(file, filterCountry(text, country));
  const skillFile = filtered.get("SKILL.md");
  if (skillFile?.ok === false)
    return excluded(`${where}/SKILL.md: ${skillFile.error}`);
  const problems = [...filtered].flatMap(([file, result]) =>
    result.ok ? [] : [`${where}/${file}: ${result.error}`],
  );
  if (header.name !== dirName)
    problems.push(
      `${where}: name "${header.name}" does not match the directory name`,
    );
  return {
    ok: true,
    name: header.name,
    description: description.text.trim(),
    files: filtered,
    problems,
  };
}

function excluded(problem: string): BuiltSkill {
  return { ok: false, problems: [`${problem}, skill not loaded`] };
}

function reader(files: ReadonlyMap<string, TextResult>) {
  return (requested: string): TextResult => {
    if (path.isAbsolute(requested)) {
      return {
        ok: false,
        error: `"${requested}" is absolute; use a path such as <skill>/SKILL.md`,
      };
    }
    if (requested.split(/[/\\]/).includes(".."))
      return { ok: false, error: `"${requested}" must not contain ".."` };
    return (
      files.get(requested) ?? {
        ok: false,
        error: `"${requested}" is not a file of a loaded skill`,
      }
    );
  };
}
