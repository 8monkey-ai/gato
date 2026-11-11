import { join } from "node:path";

import continueNote from "../../prompts/continue.md" with { type: "file" };
import conversation from "../../prompts/conversation.md" with { type: "file" };
import nudge from "../../prompts/nudge.md" with { type: "file" };
import prepareAudio from "../../prompts/prepare-audio.md" with { type: "file" };
import prepareDocument from "../../prompts/prepare-document.md" with { type: "file" };
import prepareImage from "../../prompts/prepare-image.md" with { type: "file" };
import summary from "../../prompts/summary.md" with { type: "file" };
import toolHandoff from "../../prompts/tool-handoff.md" with { type: "file" };
import toolReadSkill from "../../prompts/tool-read-skill.md" with { type: "file" };

// File imports put the defaults into the compiled binary, so the image needs no prompts folder.
const defaults = {
  conversation,
  summary,
  "prepare-image": prepareImage,
  "prepare-document": prepareDocument,
  "prepare-audio": prepareAudio,
  nudge,
  continue: continueNote,
  "tool-read-skill": toolReadSkill,
  "tool-handoff": toolHandoff,
};

export type Prompts = Record<keyof typeof defaults, string>;

export async function loadPrompts(dir?: string) {
  const [entries, problems] = await Promise.all([
    Promise.all(
      Object.entries(defaults).map(async ([name, path]) => {
        const text = await readPrompt(dir ? join(dir, `${name}.md`) : path);
        return [name, text] as const;
      }),
    ),
    dir ? unknownFiles(dir) : [],
  ]);
  return { prompts: Object.fromEntries(entries) as Prompts, problems };
}

async function readPrompt(path: string) {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`${path} is missing`);
  const text = (await file.text()).trim();
  if (!text) throw new Error(`${path} is empty`);
  return text;
}

async function unknownFiles(dir: string) {
  const known = new Set(Object.keys(defaults).map((name) => `${name}.md`));
  const problems: string[] = [];
  for await (const path of new Bun.Glob("**").scan({
    cwd: dir,
    followSymlinks: true,
  })) {
    if (known.has(path)) continue;
    problems.push(`${path} is not a prompt file and is not used`);
  }
  return problems;
}

export function fillTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (whole, key: string) => values[key] ?? whole,
  );
}
