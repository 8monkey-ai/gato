import { join } from "node:path";

import continuePath from "../../prompts/continue.md" with { type: "file" };
import conversationPath from "../../prompts/conversation.md" with { type: "file" };
import nudgePath from "../../prompts/nudge.md" with { type: "file" };
import prepareAudioPath from "../../prompts/prepare-audio.md" with { type: "file" };
import prepareDocumentPath from "../../prompts/prepare-document.md" with { type: "file" };
import prepareImagePath from "../../prompts/prepare-image.md" with { type: "file" };
import summaryPath from "../../prompts/summary.md" with { type: "file" };
import toolHandoffPath from "../../prompts/tool-handoff.md" with { type: "file" };
import toolReadSkillPath from "../../prompts/tool-read-skill.md" with { type: "file" };

// File imports put the defaults into the compiled binary, so the image needs no prompts folder.
const defaults = {
  continue: continuePath,
  conversation: conversationPath,
  nudge: nudgePath,
  "prepare-audio": prepareAudioPath,
  "prepare-document": prepareDocumentPath,
  "prepare-image": prepareImagePath,
  summary: summaryPath,
  "tool-handoff": toolHandoffPath,
  "tool-read-skill": toolReadSkillPath,
};

export type Prompts = Record<keyof typeof defaults, string>;

export async function loadPrompts(dir?: string) {
  const [entries, problems] = await Promise.all([
    Promise.all(
      Object.entries(defaults).map(
        async ([name, path]) =>
          [
            name,
            await readPrompt(dir ? join(dir, `${name}.md`) : path),
          ] as const,
      ),
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
  const paths = await Array.fromAsync(
    new Bun.Glob("**").scan({ cwd: dir, followSymlinks: true }),
  );
  return paths
    .filter((path) => !known.has(path))
    .map((path) => `${path} is not a prompt file and is not used`);
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
