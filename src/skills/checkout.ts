import { readdir, stat } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

import { type Country, filterCountry } from "./country.ts";

interface Skill {
  name: string;
  description: string;
  path: string;
}

export interface SkillsRevision {
  instructions: string;
  skills: Skill[];
  /** Returns approved material filtered for the country. Throws for other paths. */
  read(path: string): string;
}

const textFile = /\.(md|txt|json|ya?ml|csv)$/i;
const skillName = /^[a-z0-9]+(-[a-z0-9]+)*$/;

async function listFiles(root: string, dir = ""): Promise<string[]> {
  const items = await readdir(join(root, dir), { withFileTypes: true });
  const nested = await Promise.all(
    items
      .filter((item) => !item.name.startsWith("."))
      .map((item) => {
        const path = dir ? `${dir}/${item.name}` : item.name;
        if (item.isDirectory()) return listFiles(root, path);
        return Promise.resolve(textFile.test(item.name) ? [path] : []);
      }),
  );
  return nested.flat();
}

function parseSkill(path: string, content: string, country: Country): Skill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) throw new Error("missing front matter");
  const meta = Bun.YAML.parse(match[1] ?? "") as Record<string, unknown>;
  const folder = posix.basename(dirname(path));
  if (typeof meta.name !== "string" || !skillName.test(meta.name))
    throw new Error("invalid name");
  if (meta.name !== folder)
    throw new Error(`name "${meta.name}" differs from its folder "${folder}"`);
  if (typeof meta.description !== "string")
    throw new Error("missing description");
  filterCountry(content, country);
  const description = filterCountry(meta.description, country).trim();
  return { name: meta.name, description, path };
}

function catalogue(
  files: Map<string, string>,
  country: Country,
  problems: string[],
) {
  const found = new Map<string, Skill[]>();
  for (const [path, content] of files) {
    if (posix.basename(path) !== "SKILL.md") continue;
    try {
      const skill = parseSkill(path, content, country);
      found.set(skill.name, [...(found.get(skill.name) ?? []), skill]);
    } catch (error) {
      problems.push(`${path}: ${(error as Error).message}`);
    }
  }
  const skills: Skill[] = [];
  for (const [name, list] of found) {
    if (list.length > 1)
      problems.push(
        `duplicate skill "${name}": ${list.map((s) => s.path).join(", ")}`,
      );
    else if (list[0]) skills.push(list[0]);
  }
  return skills;
}

function revision(files: Map<string, string>, country: Country) {
  const problems: string[] = [];
  const agents = files.get("AGENTS.md");
  if (agents === undefined)
    throw new Error("skills checkout has no AGENTS.md instructions");
  const instructions = filterCountry(agents, country);
  const skills = catalogue(files, country, problems);
  const folders = skills.map((skill) => `${dirname(skill.path)}/`);
  const read = (path: string) => {
    const normal = posix.normalize(path.replace(/^\.\//, ""));
    const content = files.get(normal);
    if (
      content === undefined ||
      !(normal === "AGENTS.md" || folders.some((f) => normal.startsWith(f)))
    )
      throw new Error(`"${path}" is not approved skill material`);
    return filterCountry(content, country);
  };
  return {
    problems,
    revision: {
      instructions,
      skills: skills.filter((skill) => skill.description),
      read,
    },
  };
}

/** Reads the mounted checkout. A revision stays fixed after a turn takes it. */
export class SkillsCheckout {
  private cached?: { fingerprint: string; revision: SkillsRevision };

  constructor(
    private readonly root: string,
    private readonly country: Country,
    private readonly report: (problems: string[]) => void,
  ) {}

  async current(): Promise<SkillsRevision> {
    const paths = await listFiles(this.root);
    const stats = await Promise.all(
      paths.map((path) => stat(join(this.root, path))),
    );
    const fingerprint = paths
      .map((path, i) => `${path}:${stats[i]?.mtimeMs}:${stats[i]?.size}`)
      .join("|");
    if (this.cached?.fingerprint === fingerprint) return this.cached.revision;
    const contents = await Promise.all(
      paths.map((path) => Bun.file(join(this.root, path)).text()),
    );
    const files = new Map(paths.map((path, i) => [path, contents[i] ?? ""]));
    const loaded = revision(files, this.country);
    if (loaded.problems.length) this.report(loaded.problems);
    this.cached = { fingerprint, revision: loaded.revision };
    return loaded.revision;
  }
}
