import continueNote from "../../prompts/continue.md" with { type: "text" };
import conversation from "../../prompts/conversation.md" with { type: "text" };
import nudge from "../../prompts/nudge.md" with { type: "text" };
import prepareAudio from "../../prompts/prepare-audio.md" with { type: "text" };
import prepareDocument from "../../prompts/prepare-document.md" with { type: "text" };
import prepareImage from "../../prompts/prepare-image.md" with { type: "text" };
import summary from "../../prompts/summary.md" with { type: "text" };
import toolHandoff from "../../prompts/tool-handoff.md" with { type: "text" };
import toolReadSkill from "../../prompts/tool-read-skill.md" with { type: "text" };

// Text imports put the prompts into the compiled binary, so the image needs no prompts folder.
const files = {
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

export type Prompts = Record<keyof typeof files, string>;

export function loadPrompts(): Prompts {
  const entries = Object.entries(files).map(([name, raw]) => {
    const text = raw.trim();
    if (!text) throw new Error(`Prompt file prompts/${name}.md is empty`);
    return [name, text] as const;
  });
  return Object.fromEntries(entries) as Prompts;
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
