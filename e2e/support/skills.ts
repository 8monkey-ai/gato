import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { tempDir } from "./app.ts";

export const defaultSkills = {
  "AGENTS.md": "You are the customer service agent of Example Co.",
  "skills/refunds/SKILL.md":
    "---\nname: refunds\ndescription: How to handle refund requests.\n---\nRefunds take 5 days.",
};

async function run(dir: string, args: string[]) {
  const child = Bun.spawn(["git", "-C", dir, ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await child.exited) !== 0)
    throw new Error(await new Response(child.stderr).text());
}

export async function commitFiles(
  dir: string,
  files: Record<string, string | null>,
) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    if (content === null) {
      await run(dir, ["rm", "-q", path]);
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, content);
  }
  await run(dir, ["add", "-A"]);
  await run(dir, [
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-q",
    "-m",
    "update",
  ]);
}

export async function createSkillsRepo(
  files: Record<string, string> = defaultSkills,
) {
  const dir = await tempDir("gato-skills-");
  await run(dir, ["init", "-q"]);
  await commitFiles(dir, files);
  return dir;
}
